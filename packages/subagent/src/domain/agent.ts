import { AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentConfig } from "./agent-config.js";
import { Attempt } from "./agent-attempt.js";
import type { AgentRunOutcome, AttemptKind, AgentUpdateKind } from "./agent-lifecycle.js";
import type { AgentRequestedConfig } from "./agent-requested-config.js";
import { resolveRequestedConfig } from "./agent-requested-config.js";
import type { AgentEffectiveConfig, AgentRetention, AgentRunSection, AgentSnapshot, AgentViewStatus } from "./agent-snapshot.js";
import type { SpawnRequest } from "../schema.js";

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;

/** Internal retention decision shared by catalog operations and snapshot projection. */
export interface AgentCatalogRetention {
  readonly shouldRemainCataloged: boolean;
  readonly retention: AgentRetention;
}

export class Agent {

  readonly agentName: string;
  readonly createdAt = Date.now();
  readonly parentId?: string;

  private _current?: Attempt;
  private _settledAttempts: Attempt[] = [];
  private _retainedSession?: AgentSession;
  private _label: string | undefined;
  private _appliedResumableOverride: boolean | undefined;
  private _attachmentPinned = false;
  private _unsubscribe?: () => void;
  private _background: boolean;
  private _effectiveConfig: AgentEffectiveConfig | undefined;
  private _requestedConfig: AgentRequestedConfig;

  constructor(
    readonly id: string,
    readonly config: AgentConfig,
    readonly spawn: SpawnRequest,
    readonly listener: AgentUpdateListener,
    options: { background?: boolean; parentId?: string } = {},
  ) {
    this.agentName = spawn.agent;
    this._background = options.background ?? false;
    this.parentId = options.parentId;
    this._requestedConfig = resolveRequestedConfig(config, spawn);
    this._appliedResumableOverride = spawn.resumable;
    this._label = spawn.label;
    this._current = this._newAttempt("spawn", spawn.prompt, spawn.resumable);
  }

  private _newAttempt(kind: AttemptKind, prompt: string, resumableOverride: boolean | undefined): Attempt {
    return new Attempt(kind, prompt, resumableOverride, updateKind => this._emit(updateKind));
  }

  /** Begin a follow-up attempt after the runtime has validated the resume request. */
  beginResume(
    prompt: string,
    resumableOverride: boolean | undefined,
    background: boolean,
    label?: string,
  ): void {
    if (label !== undefined) this._label = label;
    this._background = background;
    this._current = this._newAttempt("resume", prompt, resumableOverride);
    this._emit("status");
  }

  private _emit(kind: AgentUpdateKind) {
    this.listener(this, kind);
  }

  get background() { return this._background }

  /** The in-flight attempt if any, else the most recent terminal attempt. */
  private _activeAttempt(): Attempt | undefined {
    return this._current ?? this._lastAttempt;
  }

  /** The most recent settled attempt, or undefined before the first settle. */
  private get _lastAttempt(): Attempt | undefined {
    return this._settledAttempts.at(-1);
  }

  get hasCurrentAttempt(): boolean { return this._current !== undefined }

  get label(): string | undefined { return this._label }

  requireCurrentAttempt(): Attempt {
    if (!this._current) throw new Error(`Agent ${this.id} has no current attempt.`);
    return this._current;
  }

  /** Canonical task-facing settings for runtime setup. */
  get requestedConfig(): AgentRequestedConfig { return this._requestedConfig; }

  get resumableOverride(): boolean | undefined {
    if (this._current) return this._current.resumableOverride ?? this._appliedResumableOverride;
    return this._appliedResumableOverride;
  }

  /**
   * Canonical lifecycle status. This is exactly the snapshot's status arm — the live
   * `AgentSession` lives on the current {@link Attempt}, not here, so the same shape serves the
   * snapshot, the runtime, and the renderers without a separate internal status union.
   */
  get status(): AgentViewStatus {
    if (this._current) {
      const state = this._current.state;
      if (state.kind === "queued") return { kind: "queued", queuedAt: this._current.createdAt };
      if (state.kind === "running") return { kind: "running", startedAt: state.startedAt };
    }
    return this._terminalStatus(this._lastAttempt);
  }

  /** Build the `done`/`queued` status arm for a settled (or not-yet-settled) attempt. */
  private _terminalStatus(attempt: Attempt | undefined): AgentViewStatus {
    if (!attempt || attempt.state.kind !== "done") return { kind: "queued", queuedAt: this.createdAt };
    const outcome = attempt.state.result;
    return {
      kind: "done",
      outcome: outcome.status,
      completedAt: attempt.state.completedAt,
      resumed: attempt.kind === "resume",
      ...(attempt.state.startedAt !== undefined ? { startedAt: attempt.state.startedAt } : {}),
      ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }

  get message() { return this._activeAttempt()?.activity.message ?? "" }

  /** The session retained for a possible resume. Sticky after first attach. */
  retainedSession(): AgentSession | undefined { return this._retainedSession }

  get resumableEnabled(): boolean {
    return this._appliedResumableOverride ?? this._requestedConfig.resumable;
  }

  get conversationRetentionEnabled(): boolean {
    return this.resumableEnabled || this._attachmentPinned;
  }

  pinForAttachment(): void {
    if (this._attachmentPinned) return;
    this._attachmentPinned = true;
    this._emit("retention");
  }

  unpinAttachment(): void {
    if (!this._attachmentPinned) return;
    this._attachmentPinned = false;
    this._emit("retention");
  }

  /** Whether a current attempt or retained conversation exists, independent of policy. */
  get hasCurrentOrRetainedConversation(): boolean {
    return this._current !== undefined || this._retainedSession !== undefined;
  }

  /** Whether the current policy keeps the current/retained conversation available. */
  get shouldRetainConversation(): boolean {
    return this.conversationRetentionEnabled && this.hasCurrentOrRetainedConversation;
  }

  /** True iff this agent is eligible to be resumed right now. */
  get canResume(): boolean {
    if (!this.conversationRetentionEnabled) return false;
    if (this._current) return false;
    if (!this._retainedSession) return false;
    const last = this._lastAttempt;
    if (!last || last.state.kind !== "done") return false;
    // Pre-attach failures (no startedAt) leave the retained session intact: still resumable.
    if (last.state.startedAt === undefined) return true;
    return last.state.result.status === "completed";
  }

  /**
   * One catalog-retention decision. Active attempts remain visible even when their conversation
   * policy is disabled, but only background dispatch or a retained conversation is persistent.
   */
  get catalogRetention(): AgentCatalogRetention {
    const persistent = this._background || this.shouldRetainConversation;
    return {
      shouldRemainCataloged: this.hasCurrentAttempt || persistent,
      retention: persistent ? "persistent" : "transient",
    };
  }

  /** Prompt of the current in-flight attempt, or the most recent terminal attempt. */
  get activePrompt(): string | undefined {
    return this._activeAttempt()?.prompt;
  }

  /**
   * Completed prior attempts of a resumed agent, oldest first. The active run (`_current`, or the
   * most recent terminal attempt when settled) is excluded so its section is never duplicated.
   */
  private _previousRunSections(): AgentRunSection[] {
    const priors = this._current ? this._settledAttempts : this._settledAttempts.slice(0, -1);
    return priors.map(attempt => ({
      ...(attempt.prompt ? { prompt: attempt.prompt } : {}),
      status: this._terminalStatus(attempt),
      activity: attempt.activity.snapshot(),
      usage: attempt.activity.usage,
    }));
  }

  /**
   * Canonical, domain-owned snapshot of the agent's current state. The DTO carries raw
   * text fields (snippet, messageSnippet); presentation code compacts them when rendering.
   * `activity`/`usage` describe the active run; completed prior attempts surface in `previousRuns`.
   */
  snapshot(options: { inputIndex?: number; includeResumed?: boolean } = {}): AgentSnapshot {
    const status = this.status;
    const active = status.kind === "queued" || status.kind === "running";
    const activeAttempt = this._activeAttempt();
    const activeActivity = activeAttempt?.activity;
    const canRemove = !active && this.catalogRetention.shouldRemainCataloged;
    const previousRuns = this._previousRunSections();
    return {
      id: this.id,
      ...(options.inputIndex !== undefined ? { inputIndex: options.inputIndex } : {}),
      ...(this.parentId !== undefined ? { parentSessionId: this.parentId } : {}),
      ...(this._label !== undefined ? { label: this._label } : {}),
      ...(options.includeResumed ? { resumed: activeAttempt?.kind === "resume" } : {}),
      ...(this.activePrompt !== undefined ? { prompt: this.activePrompt } : {}),
      createdAt: this.createdAt,
      dispatch: this._background ? "background" : "foreground",
      retention: this.catalogRetention.retention,
      config: {
        name: this.agentName,
        description: this.config.description,
        source: this.config.source,
        sourcePath: this.config.sourcePath,
        model: this._requestedConfig.model,
        thinking: this._requestedConfig.thinking,
        tools: this._requestedConfig.tools,
        ...(this._requestedConfig.skills !== undefined ? { skills: this._requestedConfig.skills } : {}),
        resumable: this.shouldRetainConversation,
      },
      status,
      activity: activeActivity ? activeActivity.snapshot() : { turns: 0, compactions: 0, toolHistory: [] },
      ...(previousRuns.length > 0 ? { previousRuns } : {}),
      usage: activeActivity?.usage,
      ...(this._effectiveConfig ? { effectiveConfig: this._effectiveConfig } : {}),
      capabilities: {
        canResume: this.canResume,
        canRemove,
        canClear: canRemove,
      },
    };
  }

  setEffectiveConfig(config: AgentEffectiveConfig): void {
    this._effectiveConfig = config;
  }

  async abort(reason?: string): Promise<void> {
    const current = this._current;
    if (!current) return;
    if (current.state.kind === "running") {
      const session = current.state.session;
      await Promise.resolve(session.abort()).catch(() => undefined);
      if (!this._current) return;
      this.settle({ status: "aborted", error: reason ?? "Agent aborted." });
      return;
    }
    if (current.state.kind === "queued") {
      this.settle({ status: "skipped", error: reason ?? "Agent skipped." });
    }
  }

  attach(session: AgentSession) {
    const current = this._current;
    if (!current || current.state.kind !== "queued") {
      throw new Error(`Cannot attach a session to an agent that is ${this._describe()}.`);
    }
    this._unsubscribe = current.activity.subscribe(session);
    current.attach(session);
    if (current.resumableOverride !== undefined) {
      this._appliedResumableOverride = current.resumableOverride;
      this._requestedConfig = { ...this._requestedConfig, resumable: current.resumableOverride };
      if (this._effectiveConfig) {
        this._effectiveConfig = { ...this._effectiveConfig, resumable: this.resumableEnabled };
      }
    }
    this._retainedSession = session;
    this._emit("status");
  }

  /**
   * Settle the current attempt with a terminal outcome and return the resulting terminal
   * snapshot. Idempotent if there's no in-flight attempt — returns the current snapshot.
   */
  settle(outcome: AgentRunOutcome): AgentSnapshot {
    const current = this._current;
    if (!current) return this.snapshot();
    this._finishSubscription();
    current.settle(outcome);
    this._settledAttempts.push(current);
    this._current = undefined;
    this._emit("status");
    return this.snapshot();
  }

  private _describe(): string {
    const status = this.status;
    if (status.kind === "done") return `done (${status.outcome})`;
    return status.kind;
  }

  private _finishSubscription() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
  }
}
