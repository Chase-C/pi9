import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentRequestedConfig, AgentSource } from "./agents.js";
import { resolveRequestedConfig } from "./agents.js";
import { RunActivity, type RunActivityListener } from "./activity.js";
import type { ConversationId, RunId } from "./identifiers.js";
import type { SpawnRequest } from "./schema.js";

/** A run starts a conversation or resumes its existing SDK session. */
export type RunKind = "spawn" | "resume";
export type RunOutcomeStatus =
  | "completed"
  | "error"
  | "aborted"
  | "skipped"
  | "interrupted";

export type RunOutcome =
  | { readonly status: "completed"; readonly output?: string; readonly error?: never }
  | {
      readonly status: Exclude<RunOutcomeStatus, "completed">;
      readonly output?: never;
      readonly error?: string;
    };

export type ConversationUpdateKind =
  | "status"
  | "message"
  | "tool"
  | "turn"
  | "usage"
  | "compaction"
  | "acknowledgement"
  | "observer"
  | "nestedJoin"
  | "steer"
  | "phase";

/** The exact parent run that spawned a child conversation. */
export interface ParentRun {
  readonly conversationId: ConversationId;
  readonly runId: RunId;
}

export type SteerState = "queued" | "delivered" | "processed" | "discarded";
export interface SteerReceipt {
  readonly id: number;
  readonly state: SteerState;
  readonly acceptedAt: number;
  readonly deliveredAt?: number;
  readonly processedAt?: number;
}
interface TrackedSteerReceipt {
  id: number;
  state: SteerState;
  acceptedAt: number;
  deliveredAt?: number;
  processedAt?: number;
  deliveryText: string;
}

export type RunPhase = "starting" | "thinking" | "processing_steer" | "responding" | "executing_tool" | "settling";
export interface RunToolUse { readonly id: string; readonly name: string; readonly startedAt: number; readonly completedAt?: number; readonly isError?: boolean; readonly inputSummary?: string }
export interface RunActivitySnapshot { readonly phase: RunPhase; readonly messageSnippet?: string; readonly turns: number; readonly compactions: number; readonly toolHistory: readonly RunToolUse[] }
export interface AgentViewConfig { readonly name: string; readonly description?: string; readonly source: AgentSource | undefined; readonly sourcePath?: string; readonly model: string | undefined; readonly thinking: ModelThinkingLevel | undefined; readonly tools: readonly string[] | undefined; readonly skills?: readonly string[] }
export interface ConversationEffectiveConfig { readonly model?: string; readonly thinking?: ModelThinkingLevel; readonly cwd: string; readonly skills: readonly string[]; readonly tools: readonly string[] }
export interface ConversationRequestedOverrides { readonly model?: string; readonly thinking?: ModelThinkingLevel }
export type RunViewStatus =
  | { readonly kind: "queued"; readonly queuedAt: number }
  | { readonly kind: "running"; readonly startedAt: number }
  | { readonly kind: "done"; readonly outcome: RunOutcomeStatus; readonly completedAt: number; readonly startedAt?: number; readonly output?: string; readonly error?: string };

export type NestedJoinAttemptState = "running" | "completed" | "failed" | "interrupted";
export interface NestedJoinTargetSnapshot {
  readonly runId: RunId;
  readonly conversationId?: ConversationId;
  readonly status?: RunOutcomeStatus | "queued" | "running";
}
export interface NestedJoinAttemptSnapshot {
  readonly toolCallId?: string;
  readonly targets: readonly NestedJoinTargetSnapshot[];
  readonly state: NestedJoinAttemptState;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export interface RunSnapshot {
  readonly runId: RunId;
  readonly kind: RunKind;
  readonly prompt: string;
  readonly createdAt: number;
  readonly status: RunViewStatus;
  readonly activity: RunActivitySnapshot;
  readonly usage: Usage;
  readonly observerCount: number;
  readonly acknowledged: boolean;
  readonly nestedJoins?: readonly NestedJoinAttemptSnapshot[];
  readonly steers: readonly SteerReceipt[];
}
export interface ConversationSnapshot {
  readonly conversationId: ConversationId;
  readonly parent?: ParentRun;
  readonly label?: string;
  readonly createdAt: number;
  readonly config: AgentViewConfig;
  readonly runs: readonly RunSnapshot[];
  readonly currentRun?: RunSnapshot;
  readonly effectiveConfig?: ConversationEffectiveConfig;
  readonly requestedOverrides?: ConversationRequestedOverrides;
  readonly canResume: boolean;
}

export type AttemptState =
  | { readonly kind: "queued" }
  | { readonly kind: "running"; readonly session: AgentSession; readonly startedAt: number }
  | { readonly kind: "done"; readonly result: RunOutcome; readonly startedAt?: number; readonly completedAt: number };

/** Mutable execution holder. Once terminal, its state and projected history entry never change. */
export class Run {
  readonly createdAt = Date.now();
  readonly activity: RunActivity;
  state: AttemptState = { kind: "queued" };
  observerCount = 0;
  acknowledged = false;
  readonly nestedJoins: Array<{ toolCallId?: string; targets: NestedJoinTargetSnapshot[]; state: NestedJoinAttemptState; startedAt: number; completedAt?: number; error?: string }> = [];
  readonly steers: TrackedSteerReceipt[] = [];
  constructor(readonly runId: RunId, readonly kind: RunKind, readonly prompt: string, private readonly onChange: RunActivityListener) {
    this.activity = new RunActivity(onChange, event => this.handleSessionEvent(event));
  }

  attach(session: AgentSession): void {
    if (this.state.kind !== "queued") throw new Error(`Cannot attach a session to a run that is ${this.state.kind}.`);
    this.state = { kind: "running", session, startedAt: Date.now() };
  }

  acceptSteer(deliveryText: string): SteerReceipt {
    const state: SteerState = this.state.kind === "running" ? "queued" : "discarded";
    const receipt: TrackedSteerReceipt = { id: this.steers.length + 1, state, acceptedAt: Date.now(), deliveryText };
    this.steers.push(receipt);
    return projectSteer(receipt);
  }

  private handleSessionEvent(event: AgentSessionEvent): RunPhase | undefined {
    if (event.type !== "message_start") return;
    if (event.message.role === "user") {
      const text = messageText(event.message.content);
      const receipt = this.steers.find(steer => steer.state === "queued" && steer.deliveryText === text);
      if (!receipt) return;
      receipt.state = "delivered";
      receipt.deliveredAt = Date.now();
      this.onChange("steer");
      return "processing_steer";
    }
    if (event.message.role !== "assistant") return;
    const delivered = this.steers.filter(steer => steer.state === "delivered");
    if (!delivered.length) return;
    const processedAt = Date.now();
    for (const receipt of delivered) {
      receipt.state = "processed";
      receipt.processedAt = processedAt;
    }
    this.onChange("steer");
    return "responding";
  }

  beginNestedJoin(runIds: readonly RunId[], toolCallId?: string): number {
    this.nestedJoins.push({ ...(toolCallId ? { toolCallId } : {}), targets: runIds.map(runId => ({ runId })), state: "running", startedAt: Date.now() });
    return this.nestedJoins.length - 1;
  }

  updateNestedJoin(index: number, update: { targets?: readonly NestedJoinTargetSnapshot[]; state?: NestedJoinAttemptState; error?: string }): void {
    const attempt = this.nestedJoins[index];
    if (!attempt || attempt.state !== "running") return;
    if (update.targets) attempt.targets = update.targets.map(target => ({ ...target }));
    if (update.state) attempt.state = update.state;
    if (update.error !== undefined) attempt.error = update.error;
    if (update.state && update.state !== "running") attempt.completedAt = Date.now();
  }

  settle(result: RunOutcome): boolean {
    if (this.state.kind === "done") return false;
    for (const receipt of this.steers) {
      if (receipt.state === "queued" || receipt.state === "delivered") receipt.state = "discarded";
    }
    const startedAt = this.state.kind === "running" ? this.state.startedAt : undefined;
    this.state = Object.freeze({ kind: "done", result: Object.freeze({ ...result }), startedAt, completedAt: Date.now() });
    return true;
  }
}

export function finalizeRun(agent: Conversation, runId: RunId, outcome: RunOutcome): RunSnapshot { return agent.settle(runId, outcome); }
export function completedRun(agent: Conversation, runId: RunId, output: string): RunSnapshot { return finalizeRun(agent, runId, { status: "completed", output }); }
export function errorRun(agent: Conversation, runId: RunId, error: string): RunSnapshot { return finalizeRun(agent, runId, { status: "error", error }); }
export function interruptedRun(agent: Conversation, runId: RunId, error: string): RunSnapshot { return finalizeRun(agent, runId, { status: "interrupted", error }); }
export function skippedRun(agent: Conversation, runId: RunId): RunSnapshot { return finalizeRun(agent, runId, { status: "skipped", error: "Agent skipped." }); }

export function effectiveStatus(status: RunViewStatus): string {
  return status.kind === "done" ? status.outcome : status.kind;
}

function projectSteer(steer: TrackedSteerReceipt): SteerReceipt {
  return Object.freeze({
    id: steer.id,
    state: steer.state,
    acceptedAt: steer.acceptedAt,
    ...(steer.deliveredAt !== undefined ? { deliveredAt: steer.deliveredAt } : {}),
    ...(steer.processedAt !== undefined ? { processedAt: steer.processedAt } : {}),
  });
}

function clearSessionQueue(session: AgentSession | undefined): void {
  try { session?.clearQueue?.(); } catch {}
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map(part => part.text)
    .join("\n");
}

export type ConversationUpdateListener = (agent: Conversation, kind: ConversationUpdateKind) => void;
export interface RunBinding { readonly runId: RunId; snapshot(): RunSnapshot; acknowledge(): void; release(): void }

/** One persistent conversation containing an append-only, exact-run history. */
export class Conversation {
  readonly createdAt = Date.now();
  readonly agentName: string;
  parent?: ParentRun;
  readonly requestedConfig: AgentRequestedConfig;
  readonly requestedOverrides?: ConversationRequestedOverrides;
  readonly label?: string;
  private readonly runs: Run[] = [];
  private currentRun?: Run;
  private session?: AgentSession;
  private stopping?: { runId: RunId; abortSettled: boolean; executionSettled: boolean };
  private steerTail: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private effectiveConfig?: ConversationEffectiveConfig;

  constructor(
    readonly conversationId: ConversationId,
    initialRunId: RunId,
    readonly config: AgentConfig,
    spawn: SpawnRequest,
    readonly listener: ConversationUpdateListener,
    options: { parent?: ParentRun } = {},
  ) {
    this.agentName = spawn.agent;
    this.label = spawn.label;
    this.parent = options.parent;
    this.requestedConfig = resolveRequestedConfig(config, spawn);
    if (spawn.model !== undefined || spawn.thinking !== undefined) {
      this.requestedOverrides = Object.freeze({
        ...(spawn.model !== undefined ? { model: spawn.model } : {}),
        ...(spawn.thinking !== undefined ? { thinking: spawn.thinking } : {}),
      });
    }
    this.currentRun = this.newRun(initialRunId, "spawn", spawn.prompt);
    this.runs.push(this.currentRun);
  }

  get hasCurrentRun(): boolean { return this.currentRun !== undefined; }
  get runHistory(): readonly RunSnapshot[] { return this.runs.map(run => this.project(run)); }
  get latestRunId(): RunId { return this.runs[this.runs.length - 1].runId; }
  get status(): RunViewStatus { return this.project(this.runs[this.runs.length - 1]).status; }
  get canResume(): boolean {
    const latest = this.runs.at(-1);
    return !this.currentRun && !this.stopping && !!this.session && latest?.state.kind === "done" &&
      (latest.state.result.status === "completed"
        || latest.state.result.status === "interrupted"
        || latest.state.result.status === "aborted");
  }

  private newRun(runId: RunId, kind: "spawn" | "resume", prompt: string): Run {
    return new Run(runId, kind, prompt, update => this.listener(this, update));
  }

  beginResume(runId: RunId, prompt: string): Run {
    if (!this.canResume) throw new Error(`Conversation ${this.conversationId} cannot be resumed.`);
    if (this.runs.some(run => run.runId === runId)) throw new Error(`Run ${runId} already exists.`);
    const run = this.newRun(runId, "resume", prompt);
    this.runs.push(run);
    this.currentRun = run;
    return run;
  }

  requireCurrentRun(): Run {
    if (!this.currentRun) throw new Error(`Conversation ${this.conversationId} has no active run.`);
    return this.currentRun;
  }

  bindSession(session: AgentSession): void {
    const run = this.requireCurrentRun();
    run.attach(session);
    this.session = session;
    this.unsubscribe = run.activity.subscribe(session);
    this.listener(this, "status");
  }
  sessionForResume(): AgentSession | undefined { return this.session; }
  get isStopping(): boolean { return this.stopping !== undefined; }
  reparent(parent?: ParentRun): void { this.parent = parent; }
  executionSettled(runId: RunId): void {
    if (this.stopping?.runId !== runId) return;
    this.stopping.executionSettled = true;
    this.finishStopping(runId);
  }

  steer(runId: RunId, prompt: string): Promise<SteerReceipt> {
    const pending = this.steerTail.then(async () => {
      if (this.stopping) throw new Error(`Run ${runId} is stopping and cannot be steered.`);
      const run = this.requireRun(runId);
      if (run.state.kind !== "running") {
        const status = run.state.kind === "queued" ? "queued" : run.state.result.status;
        throw new Error(`Run ${runId} is ${status} and cannot be steered.`);
      }
      const session = run.state.session;
      await session.steer(prompt);
      const deliveryText = session.getSteeringMessages?.().at(-1) ?? prompt;
      if (this.stopping) clearSessionQueue(session);
      const receipt = run.acceptSteer(deliveryText);
      this.listener(this, "steer");
      return receipt;
    });
    this.steerTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /** Stable exact-run observation retained independently of catalog removal. */
  bindRun(runId: RunId): RunBinding {
    const run = this.requireRun(runId);
    run.observerCount++;
    this.listener(this, "observer");
    let released = false;
    return {
      runId,
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

  settle(runId: RunId, outcome: RunOutcome): RunSnapshot {
    const run = this.requireRun(runId);
    if (run !== this.currentRun) return this.project(run);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (run.settle(outcome)) { this.currentRun = undefined; this.listener(this, "status"); }
    return this.project(run);
  }

  /** Terminalizes immediately, then finalizes in-flight steering before cancellation completes. */
  async abort(reason = "Agent aborted."): Promise<void> {
    const run = this.currentRun;
    if (!run) return;
    this.stopping = { runId: run.runId, abortSettled: false, executionSettled: false };
    const runningSession = run.state.kind === "running" ? run.state.session : undefined;
    clearSessionQueue(runningSession);
    this.settle(run.runId, { status: "aborted", error: reason });
    const aborting = Promise.resolve(runningSession?.abort()).catch(() => undefined);
    await this.steerTail;
    clearSessionQueue(runningSession);
    await aborting;
    if (this.stopping?.runId === run.runId) {
      this.stopping.abortSettled = true;
      this.finishStopping(run.runId);
    }
  }

  private finishStopping(runId: RunId): void {
    if (this.stopping?.runId !== runId || !this.stopping.abortSettled || !this.stopping.executionSettled) return;
    this.stopping = undefined;
    this.listener(this, "status");
  }

  beginNestedJoin(runId: RunId, targets: readonly RunId[], toolCallId?: string): number {
    const index = this.requireRun(runId).beginNestedJoin(targets, toolCallId);
    this.listener(this, "nestedJoin");
    return index;
  }
  updateNestedJoin(runId: RunId, index: number, update: { targets?: readonly NestedJoinTargetSnapshot[]; state?: NestedJoinAttemptState; error?: string }): void {
    this.requireRun(runId).updateNestedJoin(index, update);
    this.listener(this, "nestedJoin");
  }

  acknowledge(runId: RunId): void {
    const run = this.requireRun(runId);
    run.acknowledged = true;
    this.listener(this, "acknowledgement");
  }
  setEffectiveConfig(config: ConversationEffectiveConfig): void { this.effectiveConfig = config; }

  snapshot(): ConversationSnapshot {
    const runs = this.runHistory;
    return Object.freeze({
      conversationId: this.conversationId,
      ...(this.parent ? { parent: this.parent } : {}),
      ...(this.label ? { label: this.label } : {}),
      createdAt: this.createdAt,
      config: { name: this.agentName, description: this.config.description, source: this.config.source, sourcePath: this.config.sourcePath, model: this.requestedConfig.model, thinking: this.requestedConfig.thinking, tools: this.requestedConfig.tools, ...(this.requestedConfig.skills !== undefined ? { skills: this.requestedConfig.skills } : {}) },
      runs,
      ...(this.currentRun ? { currentRun: runs[runs.length - 1] } : {}),
      ...(this.effectiveConfig ? { effectiveConfig: this.effectiveConfig } : {}),
      ...(this.requestedOverrides ? { requestedOverrides: this.requestedOverrides } : {}),
      canResume: this.canResume,
    });
  }

  private requireRun(runId: RunId): Run {
    const run = this.runs.find(candidate => candidate.runId === runId);
    if (!run) throw new Error(`Unknown run ${runId} in conversation ${this.conversationId}.`);
    return run;
  }
  private project(run: Run): RunSnapshot {
    const state = run.state;
    const status: RunViewStatus = state.kind === "queued" ? { kind: "queued", queuedAt: run.createdAt }
      : state.kind === "running" ? { kind: "running", startedAt: state.startedAt }
      : { kind: "done", outcome: state.result.status, completedAt: state.completedAt, ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}), ...(state.result.output !== undefined ? { output: state.result.output } : {}), ...(state.result.error !== undefined ? { error: state.result.error } : {}) };
    const nestedJoins = run.nestedJoins.map(attempt => Object.freeze({
      ...(attempt.toolCallId ? { toolCallId: attempt.toolCallId } : {}),
      targets: Object.freeze(attempt.targets.map(target => Object.freeze({ ...target }))),
      state: attempt.state,
      startedAt: attempt.startedAt,
      ...(attempt.completedAt !== undefined ? { completedAt: attempt.completedAt } : {}),
      ...(attempt.error !== undefined ? { error: attempt.error } : {}),
    }));
    return Object.freeze({ runId: run.runId, kind: run.kind, prompt: run.prompt, createdAt: run.createdAt, status: Object.freeze(status), activity: Object.freeze(run.activity.snapshot()), usage: run.activity.usage, observerCount: run.observerCount, acknowledged: run.acknowledged, nestedJoins: Object.freeze(nestedJoins), steers: Object.freeze(run.steers.map(projectSteer)) });
  }
}
