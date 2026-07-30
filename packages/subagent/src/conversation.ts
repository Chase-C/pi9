import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  AgentDefinition,
  AgentDefinitionSummary,
  EffectiveExecutionConfig,
  ExecutionOverrides,
  RequestedExecutionConfig,
} from "./agents.js";
import { resolveRequestedConfig, summarizeAgentDefinition } from "./agents.js";
import { RunActivity, type RunActivityListener } from "./activity.js";
import type { ConversationId, RunId } from "./identifiers.js";
import type { SpawnRequest } from "./schema.js";

/** A run starts a conversation or resumes its existing SDK session. */
export type RunKind = "spawn" | "resume";

export const RUN_OUTCOME_STATUSES = ["completed", "error", "aborted", "interrupted", "skipped"] as const;
export const RUN_STATUSES = ["queued", "running", ...RUN_OUTCOME_STATUSES] as const;
export type RunOutcomeStatus = (typeof RUN_OUTCOME_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export class RunSteerError extends Error {
  constructor(readonly runId: RunId, readonly status: RunStatus | "stopping") {
    super(`Run ${runId} is ${status} and cannot be steered.`);
  }
}

export type ConversationUpdateKind =
  | "status"
  | "message"
  | "tool"
  | "turn"
  | "usage"
  | "compaction"
  | "joined"
  | "observer"
  | "nestedJoin"
  | "steer"
  | "phase"
  | "removed";

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
  readonly joined: boolean;
  readonly nestedJoins?: readonly NestedJoinAttemptSnapshot[];
  readonly steers: readonly SteerReceipt[];
}
export interface ConversationSnapshot {
  readonly conversationId: ConversationId;
  readonly parentConversationId?: ConversationId;
  readonly spawnedByRunId?: RunId;
  readonly label: string;
  readonly createdAt: number;
  readonly agent: AgentDefinitionSummary;
  readonly requestedConfig: RequestedExecutionConfig;
  readonly runs: readonly RunSnapshot[];
  readonly currentRun?: RunSnapshot;
  readonly isStopping?: true;
  readonly effectiveConfig?: EffectiveExecutionConfig;
  readonly requestedOverrides?: ExecutionOverrides;
}

export type RunState =
  | { readonly kind: "queued" }
  | { readonly kind: "running"; readonly session: AgentSession; readonly startedAt: number }
  | {
      readonly kind: "done";
      readonly outcome: RunOutcomeStatus;
      readonly startedAt?: number;
      readonly completedAt: number;
      readonly output?: string;
      readonly error?: string;
    };

/** Mutable execution holder. Once terminal, its state and projected history entry never change. */
export class Run {
  readonly createdAt = Date.now();
  readonly activity: RunActivity;
  state: RunState = { kind: "queued" };
  observerCount = 0;
  joined = false;
  readonly nestedJoins: Array<{ toolCallId?: string; targets: NestedJoinTargetSnapshot[]; state: NestedJoinAttemptState; startedAt: number; completedAt?: number; error?: string }> = [];
  readonly steers: TrackedSteerReceipt[] = [];
  sessionMessageStart = 0;
  constructor(readonly runId: RunId, readonly kind: RunKind, readonly prompt: string, private readonly onChange: RunActivityListener) {
    this.activity = new RunActivity(onChange, event => this.handleSessionEvent(event));
  }

  attach(session: AgentSession): void {
    if (this.state.kind !== "queued") throw new Error(`Cannot attach a session to a run that is ${this.state.kind}.`);
    this.sessionMessageStart = Array.isArray(session.messages) ? session.messages.length : 0;
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

  settle(outcome: RunOutcomeStatus, details: { readonly output?: string; readonly error?: string } = {}): boolean {
    if (this.state.kind === "done") return false;
    for (const receipt of this.steers) {
      if (receipt.state === "queued" || receipt.state === "delivered") receipt.state = "discarded";
    }
    const startedAt = this.state.kind === "running" ? this.state.startedAt : undefined;
    this.state = Object.freeze({ kind: "done", outcome, ...details, startedAt, completedAt: Date.now() });
    return true;
  }
}

export function completedRun(agent: Conversation, runId: RunId, output: string): RunSnapshot { return agent.settle(runId, "completed", { output }); }
export function errorRun(agent: Conversation, runId: RunId, error: string): RunSnapshot { return agent.settle(runId, "error", { error }); }
export function interruptedRun(agent: Conversation, runId: RunId, error: string): RunSnapshot { return agent.settle(runId, "interrupted", { error }); }
export function skippedRun(agent: Conversation, runId: RunId): RunSnapshot { return agent.settle(runId, "skipped", { error: "Agent skipped." }); }

export function effectiveStatus(status: RunViewStatus): RunStatus {
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

function latestAssistantText(session: AgentSession | undefined, startIndex: number): string | undefined {
  const messages = session?.messages;
  if (!Array.isArray(messages)) return;
  for (let index = messages.length - 1; index >= startIndex; index--) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message?.role !== "assistant") continue;
    const text = messageText(message.content).trim();
    if (text) return text;
  }
  return;
}

export type ConversationUpdateListener = (agent: Conversation, kind: ConversationUpdateKind) => void;
export interface RunBinding { readonly runId: RunId; snapshot(): RunSnapshot; markJoined(): void; release(): void }

/** One persistent conversation containing an append-only, exact-run history. */
export class Conversation {
  readonly createdAt = Date.now();
  readonly agentName: string;
  readonly parentConversationId?: ConversationId;
  readonly spawnedByRunId?: RunId;
  readonly requestedConfig: RequestedExecutionConfig;
  readonly requestedOverrides?: ExecutionOverrides;
  readonly label: string;
  private readonly runs: Run[] = [];
  private session?: AgentSession;
  private stopping?: { runId: RunId; abortSettled: boolean; executionSettled: boolean };
  private steerTail: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private effectiveConfig?: EffectiveExecutionConfig;

  constructor(
    readonly conversationId: ConversationId,
    initialRunId: RunId,
    readonly definition: AgentDefinition,
    spawn: SpawnRequest,
    readonly listener: ConversationUpdateListener,
    options: { parentConversationId?: ConversationId; spawnedByRunId?: RunId } = {},
  ) {
    this.agentName = spawn.agent;
    this.label = spawn.label ?? spawn.prompt;
    this.parentConversationId = options.parentConversationId;
    this.spawnedByRunId = options.spawnedByRunId;
    this.requestedConfig = resolveRequestedConfig(definition, spawn);
    if (spawn.model !== undefined || spawn.thinking !== undefined) {
      this.requestedOverrides = Object.freeze({
        ...(spawn.model !== undefined ? { model: spawn.model } : {}),
        ...(spawn.thinking !== undefined ? { thinking: spawn.thinking } : {}),
      });
    }
    this.runs.push(this.newRun(initialRunId, "spawn", spawn.prompt));
  }

  get hasCurrentRun(): boolean { return this.latestRun().state.kind !== "done"; }
  get runHistory(): readonly RunSnapshot[] { return this.runs.map(run => this.project(run)); }
  get latestRunId(): RunId { return this.latestRun().runId; }
  get status(): RunViewStatus { return this.project(this.latestRun()).status; }
  get hasActiveExecution(): boolean {
    return this.stopping !== undefined || this.latestRun().state.kind !== "done";
  }
  get latestResultJoined(): boolean {
    const latest = this.latestRun();
    return latest.state.kind === "done" && latest.joined;
  }
  get hasRetainedResumableSession(): boolean {
    const latest = this.latestRun();
    return latest.state.kind === "done" && this.session !== undefined
      && (latest.state.outcome === "completed"
        || latest.state.outcome === "interrupted"
        || latest.state.outcome === "aborted");
  }
  get isResumeAllowed(): boolean {
    const latest = this.latestRun();
    return !this.stopping && latest.state.kind === "done" && latest.observerCount === 0
      && latest.joined && this.hasRetainedResumableSession;
  }

  private newRun(runId: RunId, kind: "spawn" | "resume", prompt: string): Run {
    return new Run(runId, kind, prompt, update => this.listener(this, update));
  }

  beginResume(runId: RunId, prompt: string): Run {
    if (!this.isResumeAllowed) throw new Error(`Conversation ${this.conversationId} cannot be resumed.`);
    if (this.runs.some(run => run.runId === runId)) throw new Error(`Run ${runId} already exists.`);
    const run = this.newRun(runId, "resume", prompt);
    this.runs.push(run);
    return run;
  }

  requireCurrentRun(): Run {
    const run = this.latestRun();
    if (run.state.kind === "done") throw new Error(`Conversation ${this.conversationId} has no active run.`);
    return run;
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
  executionSettled(runId: RunId): void {
    if (this.stopping?.runId !== runId) return;
    this.stopping.executionSettled = true;
    this.finishStopping(runId);
  }

  steer(runId: RunId, prompt: string): Promise<SteerReceipt> {
    const pending = this.steerTail.then(async () => {
      if (this.stopping) throw new RunSteerError(runId, "stopping");
      const run = this.requireRun(runId);
      if (run.state.kind !== "running") {
        const status = run.state.kind === "queued" ? "queued" : run.state.outcome;
        throw new RunSteerError(runId, status);
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
      markJoined: () => this.markJoined(runId),
      release: () => {
        if (released) return;
        released = true;
        run.observerCount--;
        this.listener(this, "observer");
      },
    };
  }

  settle(runId: RunId, outcome: RunOutcomeStatus, details: { readonly output?: string; readonly error?: string } = {}): RunSnapshot {
    const run = this.requireRun(runId);
    if (run !== this.latestRun()) return this.project(run);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (run.settle(outcome, details)) this.listener(this, "status");
    return this.project(run);
  }

  /** Terminalizes immediately, then finalizes in-flight steering before cancellation completes. */
  async abort(reason = "Agent aborted."): Promise<void> {
    if (!this.hasCurrentRun) return;
    const run = this.latestRun();
    this.stopping = { runId: run.runId, abortSettled: false, executionSettled: false };
    const runningSession = run.state.kind === "running" ? run.state.session : undefined;
    clearSessionQueue(runningSession);
    const partialOutput = latestAssistantText(runningSession, run.sessionMessageStart);
    this.settle(run.runId, "aborted", {
      error: reason,
      ...(partialOutput ? { output: partialOutput } : {}),
    });
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

  forceAbandonCancellation(runId: RunId): RunSnapshot {
    const run = this.requireRun(runId);
    if (this.stopping?.runId === runId) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.session = undefined;
      this.stopping = undefined;
      this.listener(this, "status");
    }
    return this.project(run);
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

  markJoined(runId: RunId): void {
    const run = this.requireRun(runId);
    run.joined = true;
    this.listener(this, "joined");
  }
  setEffectiveConfig(config: EffectiveExecutionConfig): void { this.effectiveConfig = config; }

  snapshot(): ConversationSnapshot {
    const runs = this.runHistory;
    const currentRun = this.hasCurrentRun ? runs.at(-1) : undefined;
    return Object.freeze({
      conversationId: this.conversationId,
      ...(this.parentConversationId ? { parentConversationId: this.parentConversationId } : {}),
      ...(this.spawnedByRunId ? { spawnedByRunId: this.spawnedByRunId } : {}),
      label: this.label,
      createdAt: this.createdAt,
      agent: summarizeAgentDefinition(this.definition),
      requestedConfig: this.requestedConfig,
      runs,
      ...(currentRun ? { currentRun } : {}),
      ...(this.stopping ? { isStopping: true as const } : {}),
      ...(this.effectiveConfig ? { effectiveConfig: this.effectiveConfig } : {}),
      ...(this.requestedOverrides ? { requestedOverrides: this.requestedOverrides } : {}),
    });
  }

  private latestRun(): Run {
    return this.runs[this.runs.length - 1];
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
      : { kind: "done", outcome: state.outcome, completedAt: state.completedAt, ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}), ...(state.output !== undefined ? { output: state.output } : {}), ...(state.error !== undefined ? { error: state.error } : {}) };
    const nestedJoins = run.nestedJoins.map(attempt => Object.freeze({
      ...(attempt.toolCallId ? { toolCallId: attempt.toolCallId } : {}),
      targets: Object.freeze(attempt.targets.map(target => Object.freeze({ ...target }))),
      state: attempt.state,
      startedAt: attempt.startedAt,
      ...(attempt.completedAt !== undefined ? { completedAt: attempt.completedAt } : {}),
      ...(attempt.error !== undefined ? { error: attempt.error } : {}),
    }));
    return Object.freeze({ runId: run.runId, kind: run.kind, prompt: run.prompt, createdAt: run.createdAt, status: Object.freeze(status), activity: Object.freeze(run.activity.snapshot()), usage: run.activity.usage, observerCount: run.observerCount, joined: run.joined, nestedJoins: Object.freeze(nestedJoins), steers: Object.freeze(run.steers.map(projectSteer)) });
  }
}
