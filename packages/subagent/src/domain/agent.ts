import { AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentConfig } from "./agent-config.js";
import { Attempt } from "./agent-attempt.js";
import type {
  AgentDispatch,
  AgentRetentionDecision,
  AgentRunOutcome,
  AgentUpdateKind,
  AttemptKind,
} from "./agent-lifecycle.js";
import type { AgentRequestedConfig } from "./agent-requested-config.js";
import { resolveRequestedConfig } from "./agent-requested-config.js";
import type {
  AgentEffectiveConfig,
  AgentRunSection,
  AgentSnapshot,
  AgentViewStatus,
} from "./agent-snapshot.js";
import type { SpawnRequest } from "../schema.js";

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;

export class Agent {
  readonly agentName: string;
  readonly createdAt = Date.now();
  readonly parentId?: string;
  private _current?: Attempt;
  private _settledAttempts: Attempt[] = [];
  private _retainedSession?: AgentSession;
  private _unsubscribe?: () => void;
  private _effectiveConfig?: AgentEffectiveConfig;
  private readonly _requestedConfig: AgentRequestedConfig;
  private readonly _label?: string;

  constructor(
    readonly id: string,
    readonly config: AgentConfig,
    spawn: SpawnRequest,
    readonly listener: AgentUpdateListener,
    options: { dispatch?: AgentDispatch; parentId?: string } = {},
  ) {
    this.agentName = spawn.agent;
    this.parentId = options.parentId;
    this._label = spawn.label;
    this._requestedConfig = resolveRequestedConfig(config, spawn);
    this._current = this._newAttempt(
      "spawn",
      options.dispatch ?? "foreground",
      spawn.prompt,
    );
  }

  private _newAttempt(
    kind: AttemptKind,
    dispatch: AgentDispatch,
    prompt: string,
  ): Attempt {
    return new Attempt(kind, dispatch, prompt, (update) => this._emit(update));
  }

  beginResume(prompt: string, dispatch: AgentDispatch): void {
    this._current = this._newAttempt("resume", dispatch, prompt);
    this._emit("status");
  }

  private _emit(kind: AgentUpdateKind): void {
    this.listener(this, kind);
  }
  private _activeAttempt(): Attempt | undefined {
    return this._current ?? this._lastAttempt;
  }
  private get _lastAttempt(): Attempt | undefined {
    return this._settledAttempts.at(-1);
  }
  get hasCurrentAttempt(): boolean {
    return this._current !== undefined;
  }
  get label(): string | undefined {
    return this._label;
  }
  get requestedConfig(): AgentRequestedConfig {
    return this._requestedConfig;
  }

  requireCurrentAttempt(): Attempt {
    if (!this._current)
      throw new Error(`Agent ${this.id} has no current attempt.`);
    return this._current;
  }

  get status(): AgentViewStatus {
    if (this._current) {
      const state = this._current.state;
      if (state.kind === "queued")
        return { kind: "queued", queuedAt: this._current.createdAt };
      if (state.kind === "running")
        return { kind: "running", startedAt: state.startedAt };
    }
    return this._terminalStatus(this._lastAttempt);
  }

  private _terminalStatus(attempt: Attempt | undefined): AgentViewStatus {
    if (!attempt || attempt.state.kind !== "done")
      return { kind: "queued", queuedAt: this.createdAt };
    const outcome = attempt.state.result;
    return {
      kind: "done",
      outcome: outcome.status,
      completedAt: attempt.state.completedAt,
      ...(attempt.state.startedAt !== undefined
        ? { startedAt: attempt.state.startedAt }
        : {}),
      ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }

  get message(): string {
    return this._activeAttempt()?.activity.message ?? "";
  }
  retainedSession(): AgentSession | undefined {
    return this._retainedSession;
  }
  get hasCurrentOrRetainedConversation(): boolean {
    return this._current !== undefined || this._retainedSession !== undefined;
  }

  private _releaseConversationIfUnused(): void {
    if (this._current === undefined && !this.retentionDecision.keepConversation) {
      this._retainedSession = undefined;
    }
  }

  private _resumeSucceededBefore(attempt: Attempt): boolean {
    let index = this._settledAttempts.indexOf(attempt);
    let candidate: Attempt | undefined = attempt;
    while (
      candidate?.state.kind === "done" &&
      candidate.state.startedAt === undefined
    ) {
      candidate = this._settledAttempts[--index];
    }
    return (
      candidate?.state.kind === "done" &&
      candidate.state.startedAt !== undefined &&
      candidate.state.result.status === "completed"
    );
  }

  /** The single authoritative lifecycle and retention decision. */
  get retentionDecision(): AgentRetentionDecision {
    const active = this._current !== undefined;
    const last = this._lastAttempt;
    const latest = this._current ?? last;
    const backgroundResult = latest?.dispatch === "background";
    const policyRetains = this._requestedConfig.conversationPolicy === "retain";
    const hasConversationToPreserve = this.hasCurrentOrRetainedConversation;
    const conversationAvailable = this._retainedSession !== undefined;
    const keepConversation = conversationAvailable && policyRetains;
    const reasons = [
      ...(active ? ["active" as const] : []),
      ...(backgroundResult ? ["background-result" as const] : []),
      ...(policyRetains && hasConversationToPreserve
        ? ["conversation-policy" as const]
        : []),
    ];
    const cataloged = active || backgroundResult || keepConversation;
    const canResume =
      !active &&
      keepConversation &&
      last !== undefined &&
      this._resumeSucceededBefore(last);
    return {
      cataloged,
      catalog: reasons.some((reason) => reason !== "active")
        ? "persistent"
        : "transient",
      keepConversation,
      conversationAvailable,
      canResume,
      canRemove: !active && cataloged,
      reasons,
    };
  }

  get activePrompt(): string | undefined {
    return this._activeAttempt()?.prompt;
  }
  private _previousRunSections(): AgentRunSection[] {
    const priors = this._current
      ? this._settledAttempts
      : this._settledAttempts.slice(0, -1);
    return priors.map((attempt) => ({
      ...(attempt.prompt ? { prompt: attempt.prompt } : {}),
      attempt: { kind: attempt.kind, dispatch: attempt.dispatch },
      status: this._terminalStatus(attempt),
      activity: attempt.activity.snapshot(),
      usage: attempt.activity.usage,
    }));
  }

  snapshot(options: { inputIndex?: number } = {}): AgentSnapshot {
    const status = this.status;
    const attempt = this._activeAttempt();
    if (!attempt) throw new Error(`Agent ${this.id} has no attempt.`);
    const activity = attempt.activity;
    const decision = this.retentionDecision;
    const previousRuns = this._previousRunSections();
    return {
      id: this.id,
      ...(options.inputIndex !== undefined
        ? { inputIndex: options.inputIndex }
        : {}),
      ...(this.parentId !== undefined
        ? { parentSessionId: this.parentId }
        : {}),
      ...(this.label !== undefined ? { label: this.label } : {}),
      ...(this.activePrompt !== undefined ? { prompt: this.activePrompt } : {}),
      createdAt: this.createdAt,
      attempt: { kind: attempt.kind, dispatch: attempt.dispatch },
      conversation: {
        policy: this._requestedConfig.conversationPolicy,
        available: decision.conversationAvailable,
      },
      retention: { catalog: decision.catalog, reasons: decision.reasons },
      config: {
        name: this.agentName,
        description: this.config.description,
        source: this.config.source,
        sourcePath: this.config.sourcePath,
        model: this._requestedConfig.model,
        thinking: this._requestedConfig.thinking,
        tools: this._requestedConfig.tools,
        ...(this._requestedConfig.skills !== undefined
          ? { skills: this._requestedConfig.skills }
          : {}),
      },
      status,
      activity: activity.snapshot(),
      ...(previousRuns.length ? { previousRuns } : {}),
      usage: activity.usage,
      ...(this._effectiveConfig
        ? { effectiveConfig: this._effectiveConfig }
        : {}),
      capabilities: {
        canResume: decision.canResume,
        canRemove: decision.canRemove,
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
      await Promise.resolve(current.state.session.abort()).catch(
        () => undefined,
      );
      if (this._current)
        this.settle({ status: "aborted", error: reason ?? "Agent aborted." });
    } else
      this.settle({ status: "skipped", error: reason ?? "Agent skipped." });
  }

  bindSession(session: AgentSession): void {
    const current = this._current;
    if (!current || current.state.kind !== "queued")
      throw new Error(
        `Cannot bind a session to an agent that is ${this._describe()}.`,
      );
    this._unsubscribe = current.activity.subscribe(session);
    current.attach(session);
    this._retainedSession = session;
    this._emit("status");
  }

  settle(outcome: AgentRunOutcome): AgentSnapshot {
    const current = this._current;
    if (!current) return this.snapshot();
    this._finishSubscription();
    current.settle(outcome);
    this._settledAttempts.push(current);
    this._current = undefined;
    this._releaseConversationIfUnused();
    this._emit("status");
    return this.snapshot();
  }
  private _describe(): string {
    const status = this.status;
    return status.kind === "done" ? `done (${status.outcome})` : status.kind;
  }
  private _finishSubscription(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
  }
}
