import { randomUUID } from "node:crypto";

import { AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentActivity } from "./agent-activity.js";
import { AgentConfig } from "./agent-config.js";
import { Attempt } from "./agent-attempt.js";
import { buildAgentResult, type AgentResultContext, type AgentRunResult } from "./agent-result.js";
import type { AgentSnapshot, AgentViewStatus } from "./agent-snapshot.js";
import type { ResumeRequest, SpawnRequest } from "../schema.js";
import { timingMark } from "../runtime/timing.js";
import { preflightFailure, PreflightFailure } from "./preflight-failure.js";
import { AgentRegistry } from "./agent-registry.js";

export type AgentUpdateKind = "status" | "message" | "tool" | "turn" | "usage" | "compaction";

export type AgentStatus =
  | { kind: "queued"; queuedAt: number }
  | { kind: "running"; session: AgentSession; startedAt: number }
  | { kind: "done"; result: AgentRunResult; startedAt?: number; completedAt: number };

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
  private _lastAttempt?: Attempt;
  private _retainedSession?: AgentSession;
  private _label: string | undefined;
  private _appliedResumableOverride: boolean | undefined;
  private _unsubscribe?: () => void;
  private _background: boolean;
  private readonly _activity = new AgentActivity(kind => this._emit(kind));

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
    this._current = new Attempt("spawn", spawn.prompt, spawn.resumable);
  }

  static resolve(
    args: ResolveArgs,
  ):
    | { kind: "spawn"; agent: Agent }
    | { kind: "resume"; agent: Agent }
    | { kind: "failure"; failure: PreflightFailure } {
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
      } else if (!target.canResume) {
        error = `Cannot resume subagent session ${task.sessionId} while it is ${target.status.kind === "done" ? target.status.result.status : target.status.kind}.`;
      } else {
        if (task.label !== undefined) target._label = task.label;
        target._background = background;
        target._current = new Attempt("resume", task.prompt, task.resumable);
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

  /** Prompt of the current in-flight attempt, or the most recent terminal attempt. */
  get activePrompt(): string | undefined {
    return this._activeAttempt()?.prompt;
  }

  /**
   * Canonical, domain-owned snapshot of the agent's current state. The DTO carries raw
   * text fields (snippet, messageSnippet); presentation code compacts them when rendering.
   */
  snapshot(options: { inputIndex?: number } = {}): AgentSnapshot {
    const active = this.status.kind === "queued" || this.status.kind === "running";
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
      status: this._snapshotStatus(),
      activity: this._activity.snapshot(),
      usage: this._activity.usage,
      capabilities: {
        canResume: this.canResume,
        canClear: this.resumable && !active,
      },
    };
  }

  private _snapshotStatus(): AgentViewStatus {
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
      ...(rawSnippet ? { snippet: rawSnippet } : {}),
    };
  }

  /** Snapshot of the data needed to build an AgentRunResult for the current attempt. */
  resultContext(): AgentResultContext {
    const resumable = this.hasResumableSession();
    const model = this.spawn.model ?? this.config.model;
    return {
      sessionId: this.id,
      agentName: this.agentName,
      ...(this._label !== undefined ? { label: this._label } : {}),
      prompt: this.requireCurrentAttempt().prompt,
      ...(model !== undefined ? { model } : {}),
      ...(this.parentId !== undefined ? { parentSessionId: this.parentId } : {}),
      resumable,
    };
  }

  async abort(reason?: string): Promise<void> {
    const current = this._current;
    if (!current) {
      timingMark("agent.abort.noop", { sessionId: this.id, agent: this.agentName, parentSessionId: this.parentId, reason });
      return;
    }
    const resumed = current.kind === "resume";
    timingMark("agent.abort.invoke", { sessionId: this.id, agent: this.agentName, parentSessionId: this.parentId, currentStateKind: current.state.kind, attemptKind: current.kind, reason });
    if (current.state.kind === "running") {
      const session = current.state.session;
      await Promise.resolve(session.abort()).catch(() => undefined);
      if (!this._current) return;
      this.settle(buildAgentResult(this.resultContext(), { status: "aborted", error: reason ?? "Agent aborted.", resumed }));
      return;
    }
    if (current.state.kind === "queued") {
      this.settle(buildAgentResult(this.resultContext(), { status: "skipped", error: reason ?? "Agent skipped.", resumed }));
    }
  }

  attach(session: AgentSession) {
    const current = this._current;
    if (!current || current.state.kind !== "queued") {
      throw new Error(`Cannot attach a session to an agent that is ${this._describe()}.`);
    }
    timingMark("agent.attach", { sessionId: this.id, agent: this.agentName, parentSessionId: this.parentId, attemptKind: current.kind });
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
    timingMark("agent.settle", { sessionId: this.id, agent: this.agentName, parentSessionId: this.parentId, outcome: result.status, attemptKind: current.kind });
    this._finishSubscription();
    current.settle(result);
    this._lastAttempt = current;
    this._current = undefined;
    this._emit("status");
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
