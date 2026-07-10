import { randomUUID } from "node:crypto";

import { AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentConfig } from "./agent-config.js";
import { Attempt, type AttemptKind } from "./agent-attempt.js";
import type { AgentOutcome } from "./agent-result.js";
import type { AgentEffectiveConfig, AgentRunSection, AgentSnapshot, AgentViewStatus } from "./agent-snapshot.js";
import type { ResumeRequest, SpawnRequest } from "../schema.js";
import { preflightFailure } from "./preflight-failure.js";
import { AgentRegistry } from "./agent-registry.js";

export type AgentUpdateKind = "status" | "message" | "tool" | "turn" | "usage" | "compaction";

interface ResolveArgs {
  task: SpawnRequest | ResumeRequest;
  background: boolean;
  groupId: string;
  inputIndex: number;
  createdAt: number;
  registry: AgentRegistry;
  findAgent: (id: string) => Agent | undefined;
  listener: AgentUpdateListener;
  parentId?: string,
}

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;

export class Agent {

  readonly agentName: string;
  readonly createdAt = Date.now();
  readonly parentId?: string;

  private _current?: Attempt;
  private _settledAttempts: Attempt[] = [];
  private _retainedSession?: AgentSession;
  private _label: string | undefined;
  private _appliedResumableOverride: boolean | undefined;
  private _unsubscribe?: () => void;
  private _background: boolean;
  private _effectiveConfig: AgentEffectiveConfig | undefined;

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
    this._appliedResumableOverride = spawn.resumable;
    this._label = spawn.label;
    this._current = this._newAttempt("spawn", spawn.prompt, spawn.resumable);
  }

  private _newAttempt(kind: AttemptKind, prompt: string, resumableOverride: boolean | undefined): Attempt {
    return new Attempt(kind, prompt, resumableOverride, updateKind => this._emit(updateKind));
  }

  static resolve(
    args: ResolveArgs,
  ):
    | { kind: "spawn"; agent: Agent }
    | { kind: "resume"; agent: Agent }
    | { kind: "failure"; failure: AgentSnapshot } {
    const { task, background, registry, findAgent, listener, parentId } = args;
    if (task.kind === "spawn") {
      const config = registry.agents.get(task.agent);
      if (config) {
        return {
          kind: "spawn",
          agent: new Agent(randomUUID(), config, task, listener, { background, parentId }),
        };
      }

      const available = Array.from(registry.agents.values()).map(a => `- ${a.name} (${a.source})`).join("\n");
      const error = `Unknown agent: ${task.agent}. Available agents:\n${available}`;
      return {
        kind: "failure",
        failure: preflightFailure(args, { error }),
      };
    } else {
      const target = findAgent(task.sessionId);
      let error: string | undefined;
      if (!target) {
        error = `Unknown resumable subagent session: ${task.sessionId}`;
      } else if (target.hasCurrentAttempt) {
        error = `Cannot resume subagent session ${task.sessionId}: it is already resuming.`;
      } else if (!target.resumableEnabled) {
        error = `Cannot resume subagent session ${task.sessionId}: it was created with resumable: false.`;
      } else if (!target.canResume) {
        error = `Cannot resume subagent session ${task.sessionId} while it is ${target.status.kind === "done" ? target.status.outcome : target.status.kind}.`;
      } else {
        if (task.label !== undefined) target._label = task.label;
        target._background = background;
        target._current = target._newAttempt("resume", task.prompt, task.resumable);
        target._emit("status");
        return { kind: "resume", agent: target };
      }

      return {
        kind: "failure",
        failure: preflightFailure(args, { error: error!, target }),
      }
    }
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
      resumed: outcome.resumed,
      ...(attempt.state.startedAt !== undefined ? { startedAt: attempt.state.startedAt } : {}),
      ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }

  get message() { return this._activeAttempt()?.activity.message ?? "" }

  /** The session retained for a possible resume. Sticky after first attach. */
  retainedSession(): AgentSession | undefined { return this._retainedSession }

  /** True iff this agent is eligible to be resumed right now. */
  get canResume(): boolean {
    if (!this.resumable) return false;
    if (this._current) return false;
    if (!this._retainedSession) return false;
    const last = this._lastAttempt;
    if (!last || last.state.kind !== "done") return false;
    // Pre-attach failures (no startedAt) leave the retained session intact: still resumable.
    if (last.state.startedAt === undefined) return true;
    return last.state.result.status === "completed";
  }

  get resumableEnabled(): boolean {
    return this._appliedResumableOverride ?? this.config.resumable;
  }

  get resumable(): boolean {
    if (!this.resumableEnabled) return false;
    if (this._current) return true;
    return this._retainedSession !== undefined;
  }

  hasResumableSession(): boolean {
    if (!this.resumableEnabled) return false;
    if (this._current?.state.kind === "running") return true;
    return this._retainedSession !== undefined;
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
  snapshot(options: { inputIndex?: number } = {}): AgentSnapshot {
    const status = this.status;
    const active = status.kind === "queued" || status.kind === "running";
    const activeActivity = this._activeAttempt()?.activity;
    const previousRuns = this._previousRunSections();
    return {
      id: this.id,
      ...(options.inputIndex !== undefined ? { inputIndex: options.inputIndex } : {}),
      ...(this.parentId !== undefined ? { parentSessionId: this.parentId } : {}),
      ...(this._label !== undefined ? { label: this._label } : {}),
      ...(this.activePrompt !== undefined ? { prompt: this.activePrompt } : {}),
      createdAt: this.createdAt,
      dispatch: this._background ? "background" : "foreground",
      retention: this._background || this.resumable ? "persistent" : "transient",
      config: {
        name: this.agentName,
        description: this.config.description,
        source: this.config.source,
        sourcePath: this.config.sourcePath,
        model: this.spawn.model ?? this.config.model,
        thinking: this.spawn.thinking ?? this.config.thinking,
        tools: this.config.tools,
        ...(this.config.skills !== undefined ? { skills: this.config.skills } : {}),
        resumable: this.resumable,
      },
      status,
      activity: activeActivity ? activeActivity.snapshot() : { turns: 0, compactions: 0, toolHistory: [] },
      ...(previousRuns.length > 0 ? { previousRuns } : {}),
      usage: activeActivity?.usage,
      ...(this._effectiveConfig ? { effectiveConfig: this._effectiveConfig } : {}),
      capabilities: {
        canResume: this.canResume,
        canClear: this.resumable && !active,
      },
    };
  }

  setEffectiveConfig(config: AgentEffectiveConfig): void {
    this._effectiveConfig = config;
  }

  async abort(reason?: string): Promise<void> {
    const current = this._current;
    if (!current) return;
    const resumed = current.kind === "resume";
    if (current.state.kind === "running") {
      const session = current.state.session;
      await Promise.resolve(session.abort()).catch(() => undefined);
      if (!this._current) return;
      this.settle({ status: "aborted", error: reason ?? "Agent aborted.", resumed });
      return;
    }
    if (current.state.kind === "queued") {
      this.settle({ status: "skipped", error: reason ?? "Agent skipped.", resumed });
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
  settle(outcome: AgentOutcome): AgentSnapshot {
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
