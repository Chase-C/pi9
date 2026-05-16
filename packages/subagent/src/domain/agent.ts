import { AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentActivity } from "./agent-activity.js";
import { AgentConfig } from "./agent-config.js";
import { Attempt } from "./agent-attempt.js";
import { buildAgentResult, type AgentRunResult } from "./agent-result.js";
import type { AgentUpdateKind, AgentView, AgentViewStatus } from "./agent-view.js";
import type { ResumeRequest, SpawnRequest } from "../schema.js";
import { compact, compactMultiline, getSubagentDisplaySettings } from "../view/view-helpers.js";

export type AgentStatus =
  | { kind: "queued"; queuedAt: number }
  | { kind: "running"; session: AgentSession; startedAt: number }
  | { kind: "done"; result: AgentRunResult; startedAt?: number; completedAt: number };

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;

export class Agent {

  readonly agentName: string;
  readonly createdAt = Date.now();
  readonly parentSessionId?: string;

  private _current?: Attempt;
  private _lastAttempt?: Attempt;
  private _retainedSession?: AgentSession;
  private _label: string | undefined;
  private _appliedResumableOverride: boolean | undefined;
  private _unsubscribe?: () => void;
  private _background: boolean;
  private _listeners = new Set<AgentUpdateListener>();
  private readonly _activity = new AgentActivity(kind => this._emit(kind));

  constructor(
    readonly id: string,
    readonly config: AgentConfig,
    readonly spawn: SpawnRequest,
    options: { background?: boolean; parentSessionId?: string } = {},
  ) {
    this.agentName = spawn.agent;
    this._background = options.background ?? false;
    if (options.parentSessionId !== undefined) this.parentSessionId = options.parentSessionId;
    this._appliedResumableOverride = spawn.resumable;
    this._label = spawn.label;
    this._current = new Attempt("spawn", spawn.prompt, spawn.resumable);
  }

  on(listener: AgentUpdateListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private _emit(kind: AgentUpdateKind) {
    for (const listener of this._listeners) listener(this, kind);
  }

  get background() { return this._background }

  promoteToBackground() {
    if (this._background) return;
    this._background = true;
    this._emit("status");
  }

  /** The in-flight attempt if any, else the most recent terminal attempt. */
  private _activeAttempt(): Attempt | undefined {
    return this._current ?? this._lastAttempt;
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

  get status(): AgentStatus {
    if (this._current) {
      const state = this._current.state;
      if (state.kind === "queued") return { kind: "queued", queuedAt: this._current.createdAt };
      if (state.kind === "running") return { kind: "running", session: state.session, startedAt: state.startedAt };
    }
    const last = this._lastAttempt;
    if (!last || last.state.kind !== "done") return { kind: "queued", queuedAt: this.createdAt };
    return {
      kind: "done",
      result: last.state.result,
      ...(last.state.startedAt !== undefined ? { startedAt: last.state.startedAt } : {}),
      completedAt: last.state.completedAt,
    };
  }

  get message() { return this._activity.message }

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

  /** Begin a resume attempt. Must not be called while another attempt is in-flight. */
  startResume(request: ResumeRequest): Attempt {
    if (this._current) {
      throw new Error(`Cannot start a new attempt while one is in-flight (${this._current.state.kind}).`);
    }
    if (!this._retainedSession) {
      throw new Error(`Cannot resume an agent without a retained session.`);
    }
    if (request.label !== undefined) this._label = request.label;
    const attempt = new Attempt("resume", request.prompt, request.resumable);
    this._current = attempt;
    this._emit("status");
    return attempt;
  }

  get resumable(): boolean {
    const base = this._appliedResumableOverride ?? this.config.resumable;
    if (!base) return false;
    if (this._current) return true;
    return this._retainedSession !== undefined;
  }

  hasResumableSession(): boolean {
    const base = this._appliedResumableOverride ?? this.config.resumable;
    if (!base) return false;
    if (this._current?.state.kind === "running") return true;
    return this._retainedSession !== undefined;
  }

  toView(inputIndex?: number): AgentView {
    const activity = this._activity.snapshot();
    const last = this._activeAttempt();
    const label = this._label;
    const prompt = last?.prompt;
    const active = this.status.kind === "queued" || this.status.kind === "running";
    return {
      id: this.id,
      ...(inputIndex !== undefined ? { inputIndex } : {}),
      ...(this.parentSessionId !== undefined ? { parentSessionId: this.parentSessionId } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      createdAt: this.createdAt,
      kind: this.background ? "background" : "retained",
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
      status: this._viewStatus(),
      activity: {
        messageSnippet: activity.message ? compact(activity.message, getSubagentDisplaySettings().messageSnippetLength) : undefined,
        turns: activity.turns,
        compactions: activity.compactions,
        toolHistory: activity.toolHistory,
      },
      usage: activity.usage,
      capabilities: {
        canResume: this.canResume,
        canClear: this.resumable && !active,
      },
    };
  }

  async abort(reason?: string): Promise<void> {
    const current = this._current;
    if (!current) return;
    const resumed = current.kind === "resume";
    if (current.state.kind === "running") {
      const session = current.state.session;
      await Promise.resolve(session.abort()).catch(() => undefined);
      if (!this._current) return;
      this.settle(buildAgentResult(this, { status: "aborted", error: reason ?? "Agent aborted.", resumed }));
      return;
    }
    if (current.state.kind === "queued") {
      this.settle(buildAgentResult(this, { status: "skipped", error: reason ?? "Agent skipped.", resumed }));
    }
  }

  attach(session: AgentSession) {
    const current = this._current;
    if (!current || current.state.kind !== "queued") {
      throw new Error(`Cannot attach a session to an agent that is ${this._describe()}.`);
    }
    this._unsubscribe = this._activity.subscribe(session);
    current.attach(session);
    if (current.resumableOverride !== undefined) {
      this._appliedResumableOverride = current.resumableOverride;
    }
    this._retainedSession = session;
    this._emit("status");
  }

  /** Settle the current attempt with a result. Idempotent if there's no in-flight attempt. */
  settle(result: AgentRunResult): void {
    const current = this._current;
    if (!current) return;
    this._finishSubscription();
    current.settle(result);
    this._lastAttempt = current;
    this._current = undefined;
    this._emit("status");
  }

  private _viewStatus(): AgentViewStatus {
    const status = this.status;
    if (status.kind === "queued") return { kind: "queued", queuedAt: status.queuedAt };
    if (status.kind === "running") return { kind: "running", startedAt: status.startedAt };
    const result = status.result;
    const rawSnippet = result.status === "completed" ? result.output : result.error ?? result.status;
    return {
      kind: "done",
      outcome: result.status,
      completedAt: status.completedAt,
      ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
      ...(rawSnippet ? { snippet: compactMultiline(rawSnippet, getSubagentDisplaySettings().outputSnippetLength, getSubagentDisplaySettings().outputSnippetMaxLines) } : {}),
    };
  }

  private _describe(): string {
    const status = this.status;
    if (status.kind === "done") return `done (${status.result.status})`;
    return status.kind;
  }

  private _finishSubscription() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
  }
}
