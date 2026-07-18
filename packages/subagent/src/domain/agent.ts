import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SpawnRequest } from "../schema.js";
import type { AgentConfig } from "./agent-config.js";
import { Attempt } from "./agent-attempt.js";
import type { AgentRunOutcome, AgentUpdateKind } from "./agent-lifecycle.js";
import type { AgentRequestedConfig } from "./agent-requested-config.js";
import { resolveRequestedConfig } from "./agent-requested-config.js";
import type { AgentEffectiveConfig, AgentRunSnapshot, AgentSnapshot, AgentViewStatus } from "./agent-snapshot.js";
import type { ConversationId } from "./conversation-id.js";
import type { RunId } from "./run-id.js";

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;
export interface RunBinding { readonly runId: RunId; readonly result: Promise<AgentRunOutcome>; snapshot(): AgentRunSnapshot; acknowledge(): void; release(): void }

/** One persistent conversation containing an append-only, exact-run history. */
export class Agent {
  readonly createdAt = Date.now();
  readonly agentName: string;
  readonly parentConversationId?: ConversationId;
  readonly parentRunId?: RunId;
  readonly requestedConfig: AgentRequestedConfig;
  readonly label?: string;
  private readonly attempts: Attempt[] = [];
  private current?: Attempt;
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private effectiveConfig?: AgentEffectiveConfig;

  constructor(
    readonly conversationId: ConversationId,
    initialRunId: RunId,
    readonly config: AgentConfig,
    spawn: SpawnRequest,
    readonly listener: AgentUpdateListener,
    options: { parentConversationId?: ConversationId; parentRunId?: RunId } = {},
  ) {
    this.agentName = spawn.agent;
    this.label = spawn.label;
    this.parentConversationId = options.parentConversationId;
    this.parentRunId = options.parentRunId;
    this.requestedConfig = resolveRequestedConfig(config, spawn);
    this.current = this.newAttempt(initialRunId, "spawn", spawn.prompt);
    this.attempts.push(this.current);
  }

  get hasCurrentAttempt(): boolean { return this.current !== undefined; }
  get runHistory(): readonly AgentRunSnapshot[] { return this.attempts.map(run => this.project(run)); }
  get latestRunId(): RunId { return this.attempts[this.attempts.length - 1].runId; }
  get status(): AgentViewStatus { return this.project(this.attempts[this.attempts.length - 1]).status; }
  get canResume(): boolean {
    const latest = this.attempts.at(-1);
    return !this.current && !!this.session && latest?.state.kind === "done" &&
      (latest.state.result.status === "completed" || latest.state.result.status === "interrupted");
  }

  private newAttempt(runId: RunId, kind: "spawn" | "resume", prompt: string): Attempt {
    return new Attempt(runId, kind, prompt, update => this.listener(this, update));
  }

  beginResume(runId: RunId, prompt: string): Attempt {
    if (!this.canResume) throw new Error(`Conversation ${this.conversationId} cannot be resumed.`);
    if (this.attempts.some(run => run.runId === runId)) throw new Error(`Run ${runId} already exists.`);
    const run = this.newAttempt(runId, "resume", prompt);
    this.attempts.push(run);
    this.current = run;
    return run;
  }

  requireCurrentAttempt(): Attempt {
    if (!this.current) throw new Error(`Conversation ${this.conversationId} has no active run.`);
    return this.current;
  }

  bindSession(session: AgentSession): void {
    const run = this.requireCurrentAttempt();
    run.attach(session);
    this.session = session;
    this.unsubscribe = run.activity.subscribe(session);
    this.listener(this, "status");
  }
  sessionForResume(): AgentSession | undefined { return this.session; }

  /** Stable exact-run binding. Repeated binds share the run's one terminal promise. */
  bindRun(runId: RunId): RunBinding {
    const run = this.requireRun(runId);
    run.observerCount++;
    this.listener(this, "observer");
    let released = false;
    return {
      runId,
      result: run.completion,
      snapshot: () => this.project(run),
      acknowledge: () => this.acknowledge(runId),
      release: () => {
        if (released) return;
        released = true;
        run.observerCount--;
        this.listener(this, "observer");
      },
    };
  }

  settle(runId: RunId, outcome: AgentRunOutcome): AgentRunSnapshot {
    const run = this.requireRun(runId);
    if (run !== this.current) return this.project(run);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (run.settle(outcome)) { this.current = undefined; this.listener(this, "status"); }
    return this.project(run);
  }

  /** Terminalizes immediately; SDK cancellation is best-effort and cannot rewrite the result. */
  async abort(reason = "Agent aborted."): Promise<void> {
    const run = this.current;
    if (!run) return;
    const runningSession = run.state.kind === "running" ? run.state.session : undefined;
    this.settle(run.runId, { status: "aborted", error: reason });
    await Promise.resolve(runningSession?.abort()).catch(() => undefined);
  }

  acknowledge(runId: RunId): void {
    const run = this.requireRun(runId);
    run.acknowledged = true;
    run.notification = "notified";
    this.listener(this, "acknowledgement");
  }
  setEffectiveConfig(config: AgentEffectiveConfig): void { this.effectiveConfig = config; }

  snapshot(): AgentSnapshot {
    const runs = this.runHistory;
    return Object.freeze({
      conversationId: this.conversationId,
      ...(this.parentConversationId ? { parentConversationId: this.parentConversationId } : {}),
      ...(this.parentRunId ? { parentRunId: this.parentRunId } : {}),
      ...(this.label ? { label: this.label } : {}),
      createdAt: this.createdAt,
      config: { name: this.agentName, description: this.config.description, source: this.config.source, sourcePath: this.config.sourcePath, model: this.requestedConfig.model, thinking: this.requestedConfig.thinking, tools: this.requestedConfig.tools, ...(this.requestedConfig.skills !== undefined ? { skills: this.requestedConfig.skills } : {}) },
      runs,
      ...(this.current ? { currentRun: runs[runs.length - 1] } : {}),
      ...(this.effectiveConfig ? { effectiveConfig: this.effectiveConfig } : {}),
      capabilities: { canResume: this.canResume, canRemove: !this.current },
    });
  }

  private requireRun(runId: RunId): Attempt {
    const run = this.attempts.find(candidate => candidate.runId === runId);
    if (!run) throw new Error(`Unknown run ${runId} in conversation ${this.conversationId}.`);
    return run;
  }
  private project(run: Attempt): AgentRunSnapshot {
    const state = run.state;
    const status: AgentViewStatus = state.kind === "queued" ? { kind: "queued", queuedAt: run.createdAt }
      : state.kind === "running" ? { kind: "running", startedAt: state.startedAt }
      : { kind: "done", outcome: state.result.status, completedAt: state.completedAt, ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}), ...(state.result.output !== undefined ? { output: state.result.output } : {}), ...(state.result.error !== undefined ? { error: state.result.error } : {}) };
    return Object.freeze({ runId: run.runId, kind: run.kind, prompt: run.prompt, createdAt: run.createdAt, status: Object.freeze(status), activity: Object.freeze(run.activity.snapshot()), usage: run.activity.usage, observerCount: run.observerCount, acknowledged: run.acknowledged, notification: run.notification });
  }
}
