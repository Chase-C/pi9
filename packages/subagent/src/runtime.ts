import type { AgentSessionEvent, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentRegistry, resolveRequestedConfig } from "./agents.js";
import { Conversation, RunSteerError, errorRun, interruptedRun, skippedRun, type ConversationSnapshot, type ConversationUpdateKind, type NestedJoinTargetSnapshot, type Run, type RunSnapshot, type SteerReceipt } from "./conversation.js";
import { DEFAULT_EXECUTE_RUN_DEPENDENCIES, executeRun, resolveModel, resolveTaskCwd } from "./execute.js";
import { ConversationIdAllocator, RunIdAllocator, type ConversationId, type RunId, type SubagentId } from "./identifiers.js";
import type { SpawnRequest, ResumeRequest } from "./schema.js";
import { timingStart } from "./timing.js";

/**
 * Lets a queued task voluntarily yield its slot while awaiting work that itself
 * needs queue capacity — e.g. a parent subagent awaiting a child's batch. Without
 * this, a recursive tree deeper than maxRunning deadlocks.
 */
export interface RunQueueLease {
  suspendDuring<T>(fn: () => Promise<T>): Promise<T>;
}

export interface RunQueueTask<T> {
  readonly completion: Promise<T>;
  cancel(result: T): boolean;
}

export class RunQueue {

  private _pending = new Array<() => void>();
  private _running = 0;

  constructor(public maxRunning: number) { }

  enqueue<T>(task: (lease: RunQueueLease) => Promise<T>, timingData: Record<string, unknown> = {}): Promise<T> {
    return this.enqueueCancellable(task, timingData).completion;
  }

  enqueueCancellable<T>(task: (lease: RunQueueLease) => Promise<T>, timingData: Record<string, unknown> = {}): RunQueueTask<T> {
    let resolveTask!: (value: T) => void;
    let rejectTask!: (reason?: unknown) => void;
    let pending = true;
    const completion = new Promise<T>((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
    const queuedAt = Date.now();
    const start = () => {
      pending = false;
      this._running++;
      let active = true;
      const lease: RunQueueLease = {
        suspendDuring: async <R>(fn: () => Promise<R>): Promise<R> => {
          if (!active) return fn();
          active = false;
          this._running--;
          this._flush();
          try {
            return await fn();
          } finally {
            await this._acquire();
            active = true;
          }
        },
      };
      const waitMs = Date.now() - queuedAt;
      setImmediate(() => {
        const end = timingStart("queue.task", { ...timingData, waitMs });
        task(lease)
          .then(resolveTask, rejectTask)
          .finally(() => {
            if (active) this._running--;
            end({ running: this._running, pending: this._pending.length });
            this._flush();
          });
      });
    };
    this._pending.push(start);
    this._flush();
    return {
      completion,
      cancel: result => {
        if (!pending) return false;
        const index = this._pending.indexOf(start);
        if (index < 0) return false;
        this._pending.splice(index, 1);
        pending = false;
        resolveTask(result);
        return true;
      },
    };
  }

  private _acquire(): Promise<void> {
    return new Promise(resolve => {
      this._pending.push(() => {
        this._running++;
        resolve();
      });
      this._flush();
    });
  }

  private _flush() {
    while (this._running < this.maxRunning && this._pending.length > 0) {
      this._pending.shift()!();
    }
  }
}

export type RunExecutor = (
  ctx: ExtensionContext,
  agent: Conversation,
  run: Run,
  signal?: AbortSignal,
) => Promise<RunSnapshot>;

export interface RunSchedulerOptions {
  maxRunning: number;
  /** Override child execution. Used by tests to inject a fake executor. */
  executor?: RunExecutor;
  /** Returns false once the conversation has been removed from the catalog, signalling the queued
   *  run should be skipped rather than dispatched. Defaults to always-true. */
  isTracked?: (conversationId: string) => boolean;
}

export class RunScheduler {

  private readonly _queue: RunQueue;
  private readonly _leases = new Map<string, RunQueueLease>();
  private readonly _executor: RunExecutor;
  private readonly _queued = new Map<RunId, RunQueueTask<RunSnapshot>>();
  private _isTracked: (conversationId: string) => boolean;
  private _childTool?: (agent: Conversation) => ToolDefinition;
  private _childSessionEvent?: (agent: Conversation, run: Run, event: AgentSessionEvent) => void;

  constructor(opts: RunSchedulerOptions) {
    this._queue = new RunQueue(opts.maxRunning);
    this._isTracked = opts.isTracked ?? (() => true);
    this._executor = opts.executor ?? ((ctx, agent, run, signal) =>
      executeRun(ctx, agent, run, signal, {
        ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
        ...(this._childTool ? { childToolFor: this._childTool } : {}),
        ...(this._childSessionEvent ? { childSessionEvent: this._childSessionEvent } : {}),
      }));
  }

  setChildTool(fn: (agent: Conversation) => ToolDefinition): void {
    this._childTool = fn;
  }

  setChildSessionEvent(fn: (agent: Conversation, run: Run, event: AgentSessionEvent) => void): void {
    this._childSessionEvent = fn;
  }

  configure(opts: { maxRunning?: number }): void {
    if (opts.maxRunning !== undefined) this._queue.maxRunning = opts.maxRunning;
  }

  /**
   * Releases the named agent's queue slot while `fn` runs, then re-acquires it before returning.
   * Used by the child subagent tool so a parent awaiting `batch.completion` doesn't pin the
   * only queue slot a recursive descendant needs to start — without this, a tree deeper than
   * maxRunning deadlocks. No-op when the conversation has no active lease.
   */
  async suspendAgentSlotDuring<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const lease = this._leases.get(conversationId);
    if (!lease) return fn();
    const end = timingStart("manager.suspendAgentSlot", { conversationId });
    try {
      return await lease.suspendDuring(fn);
    } finally {
      end({});
    }
  }

  run(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    agent: Conversation,
    run: Run,
  ): Promise<RunSnapshot> {
    const kind = run.kind;
    const scheduled = this._queue.enqueueCancellable(async lease => {
      const end = timingStart(`manager.${kind}Task`, { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parentConversationId });
      let result: RunSnapshot;
      let error: string | undefined;

      if (run.state.kind === "done") {
        result = agent.runHistory.find(item => item.runId === run.runId)!;
      } else if (signal?.aborted || !this._isTracked(agent.conversationId)) {
        result = skippedRun(agent, run.runId);
      } else if (agent.status.kind === "done" && !agent.hasCurrentRun) {
        result = agent.runHistory.find(run => run.runId === run.runId)!;
      } else {
        this._leases.set(agent.conversationId, lease);
        try {
          result = await this._executor(ctx, agent, run, signal);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (agent.status.kind === "done" && !agent.hasCurrentRun) {
            result = agent.runHistory.find(run => run.runId === run.runId)!;
          } else {
            error = message;
            if (signal?.aborted) {
              if (run.state.kind === "queued") skippedRun(agent, run.runId);
              else interruptedRun(agent, run.runId, message);
            } else errorRun(agent, run.runId, message);
            result = agent.runHistory.find(run => run.runId === run.runId)!;
          }
        } finally {
          this._leases.delete(agent.conversationId);
        }
      }

      const status = result.status;
      end({ status: status.kind === "done" ? status.outcome : status.kind, error });
      return result;
    }, { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parentConversationId, kind });
    this._queued.set(run.runId, scheduled);
    const cleanup = () => { if (this._queued.get(run.runId) === scheduled) this._queued.delete(run.runId); };
    void scheduled.completion.then(cleanup, cleanup);
    return scheduled.completion;
  }

  cancelQueued(runId: RunId, result: RunSnapshot): boolean {
    return this._queued.get(runId)?.cancel(result) ?? false;
  }
}

export type ConversationUpdateListener = (agent: Conversation, kind: ConversationUpdateKind) => void;

export type OrderedStartOutcome =
  | { readonly ok: true; readonly inputIndex: number; readonly conversationId: ConversationId; readonly runId: RunId }
  | { readonly ok: false; readonly inputIndex: number; readonly error: string };
export interface RunHandle { readonly starts: readonly OrderedStartOutcome[]; readonly completion: Promise<readonly OrderedStartOutcome[]> }
export interface JoinProjection { readonly conversationId: ConversationId; readonly runId: RunId; readonly status: ConversationSnapshot["runs"][number]["status"] }
export interface JoinBinding { readonly runIds: readonly RunId[]; readonly completion: Promise<void>; project(): readonly JoinProjection[]; acknowledge(): void; release(): void }
export interface NestedJoinBinding extends JoinBinding { readonly ownerRunId: RunId; readonly attemptIndex: number; interrupt(error?: string): void }
export interface RunIdentity { readonly runId: RunId; readonly conversationId: ConversationId }
export interface SubagentCaller { readonly conversationId: ConversationId; readonly runId: RunId }
export interface ConversationDisplayIdentity { readonly conversationId: ConversationId; readonly label?: string; readonly agentName?: string }
export interface RemoveResult { removed: number; conversationIds: ConversationId[]; errors: Array<{ conversationId: string; error: string }> }
export interface CancelResult { readonly conversationId: ConversationId; readonly runId: RunId; readonly status: "aborted" }
export interface SteerResult { readonly conversationId: ConversationId; readonly runId: RunId; readonly steer: SteerReceipt }
export interface InspectedRun { readonly conversationId: ConversationId; readonly snapshot: RunSnapshot }

type JoinStatus = ConversationSnapshot["runs"][number]["status"];
type RunRecord = {
  readonly runId: RunId;
  readonly conversationId: ConversationId;
  readonly agent: Conversation;
};
interface BoundRun { readonly runId: RunId; snapshot(): { readonly status: JoinStatus }; acknowledge(): void; release(): void }
interface BoundRecord { readonly conversationId: ConversationId; readonly binding: BoundRun }

/** Owns retained conversations and their exact-run records. */
export class SubagentRuntime {
  private readonly conversations = new Map<ConversationId, Conversation>();
  private readonly runs = new Map<RunId, RunRecord>();
  private readonly listeners = new Set<ConversationUpdateListener>();
  private readonly deferredUpdates = new Map<Conversation, Set<ConversationUpdateKind>>();
  private updateDeferralDepth = 0;
  private readonly conversationIds = new ConversationIdAllocator();
  private readonly runIds = new RunIdAllocator();
  private readonly _scheduler: RunScheduler;

  constructor(readonly registry: AgentRegistry, maxRunning = 4, executor?: RunExecutor, private _maxConversations = 100) {
    this._scheduler = new RunScheduler({ maxRunning, ...(executor ? { executor } : {}), isTracked: id => this.conversations.has(id as ConversationId) });
  }
  get scheduler(): RunScheduler { return this._scheduler; }
  get maxConversations(): number { return this._maxConversations; }
  configure(options: { maxRunning?: number; maxConversations?: number }): void {
    this._scheduler.configure(options);
    if (options.maxConversations !== undefined) this._maxConversations = options.maxConversations;
  }
  onConversationUpdate(listener: ConversationUpdateListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  listConversations(): ConversationSnapshot[] { return [...this.conversations.values()].map(a => a.snapshot()); }
  queryConversations(callerConversationId?: ConversationId, scope: "children" | "descendants" = "children"): ConversationSnapshot[] {
    const children = new Map<ConversationId | undefined, Conversation[]>();
    for (const conversation of this.conversations.values()) {
      const siblings = children.get(conversation.parentConversationId) ?? [];
      siblings.push(conversation);
      children.set(conversation.parentConversationId, siblings);
    }
    const direct = children.get(callerConversationId) ?? [];
    if (scope === "children") return direct.map(conversation => conversation.snapshot());
    const result: ConversationSnapshot[] = [];
    const visit = (conversation: Conversation) => {
      result.push(conversation.snapshot());
      for (const child of children.get(conversation.conversationId) ?? []) visit(child);
    };
    for (const conversation of direct) visit(conversation);
    return result;
  }
  conversationDepth(conversationId: ConversationId, callerConversationId?: ConversationId): number {
    let current = this.requireConversation(conversationId);
    let depth = 1;
    const seen = new Set<ConversationId>();
    while (current.parentConversationId !== callerConversationId) {
      if (!current.parentConversationId || seen.has(current.conversationId)) {
        throw new Error(`Conversation ${conversationId} is outside the requested conversation tree.`);
      }
      seen.add(current.conversationId);
      current = this.requireConversation(current.parentConversationId);
      depth++;
    }
    return depth;
  }
  conversation(conversationId: string): ConversationSnapshot { return this.requireConversation(conversationId).snapshot(); }

  /** Resolves and reserves the complete batch synchronously; executions never inherit caller cancellation. */
  startRun(ctx: ExtensionContext, tasks: readonly (SpawnRequest | ResumeRequest)[], options: { caller?: SubagentCaller } = {}): RunHandle {
    const starts: OrderedStartOutcome[] = [];
    const executions: Promise<unknown>[] = [];
    const callerRecord = options.caller ? this.runs.get(options.caller.runId) : undefined;
    const callerError = options.caller && (!callerRecord || callerRecord.conversationId !== options.caller.conversationId)
      ? "Start caller is no longer active."
      : undefined;
    let reserved = this.conversations.size;
    for (let inputIndex = 0; inputIndex < tasks.length; inputIndex++) {
      const task = tasks[inputIndex];
      let agent: Conversation | undefined;
      let runId: RunId | undefined;
      let error = callerError;
      if (!error && task.kind === "spawn") {
        const config = this.registry.agents.get(task.agent);
        if (!config) error = `Unknown agent: ${task.agent}.`;
        else {
          const requested = resolveRequestedConfig(config, task);
          const model = resolveModel(requested.model, ctx.model, ctx.modelRegistry);
          const cwd = resolveTaskCwd(ctx.cwd, requested.cwd);
          if (!model.ok) error = model.error;
          else if (!cwd.ok) error = cwd.error;
          else if (reserved >= this.maxConversations) error = this.capacityError();
          else {
            const conversationId = this.conversationIds.allocate(); runId = this.runIds.allocate();
            if (!conversationId || !runId) error = "Conversation or run ID space exhausted.";
            else {
              agent = new Conversation(conversationId, runId, config, task, (a, k) => this.updated(a, k),
                options.caller ? { parentConversationId: options.caller.conversationId, spawnedByRunId: options.caller.runId } : {});
              this.conversations.set(conversationId, agent); reserved++;
            }
          }
        }
      } else if (!error && task.kind === "resume") {
        const subagentId = task.subagentId;
        agent = subagentId ? this.conversations.get(subagentId) : undefined;
        if (!agent) error = `Unknown subagent: ${subagentId}.`;
        else if (options.caller && agent.parentConversationId !== options.caller.conversationId) {
          error = `Subagent ${agent.conversationId} is not directly owned by caller subagent ${options.caller.conversationId}.`;
        }
        else if (!options.caller && agent.parentConversationId) {
          error = `Subagent ${agent.conversationId} is not directly owned by the root agent.`;
        }
        else if (agent.hasCurrentRun) {
          const status = agent.status.kind;
          if (status === "running") error = `Subagent ${subagentId} is running. Join it before resuming, or steer it while it runs.`;
          else if (status === "queued") error = `Subagent ${subagentId} is queued. Wait for or join it before resuming.`;
          else error = `Subagent ${subagentId} cannot be resumed.`;
        }
        else if (!agent.canResume) error = this.resumeError(agent);
        else { runId = this.runIds.allocate(); if (!runId) error = "Run ID space exhausted."; else agent.beginResume(runId, task.prompt); }
      }
      if (!agent || !runId || error) { starts.push({ ok: false, inputIndex, error: error ?? "Could not start run." }); continue; }
      this.runs.set(runId, { runId, conversationId: agent.conversationId, agent });
      const run = agent.requireCurrentRun();
      const execution = this._scheduler.run(ctx, undefined, agent, run)
        .finally(() => agent.executionSettled(run.runId));
      executions.push(execution);
      // Publish queued only after the catalog indexes and scheduler can resolve the run.
      this.updated(agent, "status");
      starts.push({ ok: true, inputIndex, conversationId: agent.conversationId, runId });
    }
    return { starts, completion: Promise.allSettled(executions).then(() => starts) };
  }

  async steerSubagent(subagentId: SubagentId, prompt: string, caller?: SubagentCaller): Promise<SteerResult> {
    const record = this.latestSubagentRecord(subagentId);
    this.assertCallerAccess(record.conversationId, caller, "steer");
    return this.steerRecord(record, prompt, `Subagent ${subagentId}`);
  }

  async cancelSubagent(subagentId: SubagentId, caller?: SubagentCaller): Promise<CancelResult> {
    const record = this.latestSubagentRecord(subagentId);
    this.assertCallerAccess(record.conversationId, caller, "cancel");
    return this.cancelRecord(record, `Subagent ${subagentId}`);
  }

  inspectSubagents(subagentIds: readonly SubagentId[], caller?: SubagentCaller): InspectedRun[] {
    return subagentIds.map(subagentId => {
      const record = this.latestSubagentRecord(subagentId);
      this.assertCallerAccess(record.conversationId, caller, "inspect");
      return { conversationId: record.conversationId, snapshot: this.runSnapshot(record.runId) };
    });
  }

  validateSubagentJoin(subagentId: SubagentId, caller?: SubagentCaller): void {
    this.assertDirectOwner(this.requireConversation(subagentId), caller, "join");
  }

  bindSubagentJoin(subagentIds: readonly SubagentId[], caller?: SubagentCaller, toolCallId?: string): JoinBinding | NestedJoinBinding {
    const records = subagentIds.map(subagentId => this.latestSubagentRecord(subagentId));
    for (const record of records) this.assertDirectOwner(record.agent, caller, "join");
    const runIds = records.map(record => record.runId);
    return caller ? this.bindNestedJoin(caller, runIds, toolCallId) : this.bindExactRuns(runIds);
  }

  /** Binds only the requested private executions. Resolution and observer attachment are all-or-nothing. */
  private bindExactRuns(runIds: readonly RunId[]): JoinBinding {
    const records = runIds.map(id => { const record = this.runs.get(id); if (!record) throw new Error(`Unknown run: ${id}.`); return record; });
    return this.withDeferredUpdates(() => this.bindRecords(records));
  }

  /** Records and binds one nested join attempt on the exact caller run. */
  private bindNestedJoin(caller: SubagentCaller, runIds: readonly RunId[], toolCallId?: string): NestedJoinBinding {
    return this.withDeferredUpdates(() => this.bindNestedJoinNow(caller, runIds, toolCallId));
  }

  private bindNestedJoinNow(caller: SubagentCaller, runIds: readonly RunId[], toolCallId?: string): NestedJoinBinding {
    const ownerRecord = this.runs.get(caller.runId);
    if (!ownerRecord || ownerRecord.conversationId !== caller.conversationId)
      throw new Error("Join caller is no longer active.");
    const attemptIndex = ownerRecord.agent.beginNestedJoin(caller.runId, runIds, toolCallId);
    let records: RunRecord[];
    try {
      records = runIds.map(id => {
        const record = this.runs.get(id);
        if (!record) throw new Error(`Unknown run: ${id}.`);
        this.assertCallerAccess(record.conversationId, caller, "join");
        return record;
      });
    } catch (error) {
      this.updateNestedJoin(caller.runId, attemptIndex, { state: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const base = this.bindRecords(records);
    let terminal = false;
    const targets = (): NestedJoinTargetSnapshot[] => base.project().map(value => ({
      runId: value.runId, conversationId: value.conversationId,
      status: value.status.kind === "done" ? value.status.outcome : value.status.kind,
    }));
    this.updateNestedJoin(caller.runId, attemptIndex, { targets: targets() });
    void base.completion.then(() => {
      if (terminal) return; terminal = true;
      this.updateNestedJoin(caller.runId, attemptIndex, { targets: targets(), state: "completed" });
    });
    return {
      ownerRunId: caller.runId, attemptIndex,
      get runIds() { return base.runIds; }, completion: base.completion,
      project: () => base.project(), acknowledge: () => base.acknowledge(), release: () => base.release(),
      interrupt: (error = "Nested join interrupted.") => {
        if (terminal) return; terminal = true;
        this.updateNestedJoin(caller.runId, attemptIndex, { targets: targets(), state: "interrupted", error });
        base.release();
      },
    };
  }

  runSnapshot(runId: RunId): RunSnapshot {
    const record = this.requireRunRecord(runId);
    return record.agent.runHistory.find(run => run.runId === runId)!;
  }
  conversationDisplay(conversationId: ConversationId): ConversationDisplayIdentity {
    const live = this.conversations.get(conversationId);
    if (live) return { conversationId, ...(live.label ? { label: live.label } : {}), agentName: live.agentName };
    throw new Error(`Unknown conversation: ${conversationId}.`);
  }
  directSpawnedChildren(runId: RunId): readonly RunIdentity[] {
    return [...this.conversations.values()]
      .filter(conversation => conversation.spawnedByRunId === runId)
      .map(conversation => ({ runId: conversation.runHistory[0].runId, conversationId: conversation.conversationId }));
  }
  unjoinedDirectChildren(runId: RunId): readonly RunIdentity[] {
    const mentioned = new Set((this.runSnapshot(runId).nestedJoins ?? []).flatMap(attempt => attempt.targets.map(target => target.runId)));
    return this.directSpawnedChildren(runId).filter(child => !mentioned.has(child.runId));
  }

  private bindRecords(records: readonly RunRecord[]): JoinBinding {
    const attached: BoundRecord[] = [];
    try {
      for (const record of records) {
        const binding: BoundRun = record.agent.bindRun(record.runId);
        attached.push({ conversationId: record.conversationId, binding });
      }
    } catch (error) { for (const item of attached) item.binding.release(); throw error; }
    let released = false; let resolve!: () => void;
    const completion = new Promise<void>(done => { resolve = done; });
    const check = () => { if (!released && attached.every(item => item.binding.snapshot().status.kind === "done")) resolve(); };
    const unsubscribe = this.onConversationUpdate(check);
    check();
    return {
      runIds: Object.freeze(records.map(record => record.runId)), completion,
      project: () => attached.map(item => ({ conversationId: item.conversationId, runId: item.binding.runId, status: item.binding.snapshot().status })),
      acknowledge: () => { for (const item of attached) if (item.binding.snapshot().status.kind === "done") item.binding.acknowledge(); },
      release: () => { if (released) return; released = true; unsubscribe(); for (const item of attached) item.binding.release(); },
    };
  }
  private updateNestedJoin(runId: RunId, index: number, update: { targets?: readonly NestedJoinTargetSnapshot[]; state?: "running" | "completed" | "failed" | "interrupted"; error?: string }): void {
    const record = this.runs.get(runId);
    if (!record) return;
    record.agent.updateNestedJoin(runId, index, update);
  }

  private assertDirectOwner(target: Conversation, caller: SubagentCaller | undefined, action: string): void {
    if (caller) {
      const ownerRecord = this.runs.get(caller.runId);
      if (!ownerRecord || ownerRecord.conversationId !== caller.conversationId) {
        throw new Error(`${action[0].toUpperCase()}${action.slice(1)} caller is no longer active.`);
      }
      if (target.parentConversationId !== caller.conversationId) {
        throw new Error(`Subagent ${target.conversationId} is not directly owned by caller subagent ${caller.conversationId}.`);
      }
      return;
    }
    if (target.parentConversationId) {
      throw new Error(`Subagent ${target.conversationId} is not directly owned by the root agent.`);
    }
  }

  private assertCallerAccess(targetConversationId: ConversationId, caller: SubagentCaller | undefined, action: string): void {
    if (!caller) return;
    const ownerRecord = this.runs.get(caller.runId);
    if (!ownerRecord || ownerRecord.conversationId !== caller.conversationId) {
      throw new Error(`${action[0].toUpperCase()}${action.slice(1)} caller is no longer active.`);
    }
    if (!this.isConversationDescendant(targetConversationId, caller.conversationId)) {
      throw new Error(`Conversation ${targetConversationId} is not a descendant of caller conversation ${caller.conversationId}.`);
    }
  }

  private isConversationDescendant(candidateId: ConversationId, ownerId: ConversationId): boolean {
    let current = this.conversations.get(candidateId);
    const seen = new Set<ConversationId>();
    while (current?.parentConversationId && !seen.has(current.conversationId)) {
      if (current.parentConversationId === ownerId) return true;
      seen.add(current.conversationId);
      current = this.conversations.get(current.parentConversationId);
    }
    return false;
  }

  private latestSubagentRecord(subagentId: SubagentId): RunRecord {
    const agent = this.requireConversation(subagentId);
    return this.requireRunRecord(agent.latestRunId);
  }

  private async steerRecord(record: RunRecord, prompt: string, target: string): Promise<SteerResult> {
    try {
      const steer = await record.agent.steer(record.runId, prompt);
      return { conversationId: record.conversationId, runId: record.runId, steer };
    } catch (error) {
      if (error instanceof RunSteerError) {
        throw new Error(`${target} is ${error.status} and cannot be steered.`);
      }
      throw error;
    }
  }

  private async cancelRecord(record: RunRecord, target: string): Promise<CancelResult> {
    const run = this.runSnapshot(record.runId);
    if (run.status.kind === "done") {
      throw new Error(`${target} is ${run.status.outcome} and cannot be cancelled.`);
    }
    const wasQueued = run.status.kind === "queued";
    const aborting = record.agent.abort("Run cancelled.");
    if (wasQueued) {
      const aborted = record.agent.runHistory.find(item => item.runId === record.runId)!;
      this._scheduler.cancelQueued(record.runId, aborted);
    }
    await aborting;
    return { conversationId: record.conversationId, runId: record.runId, status: "aborted" };
  }

  private requireRunRecord(runId: RunId): RunRecord { const record = this.runs.get(runId); if (!record) throw new Error(`Unknown run: ${runId}.`); return record; }

  removeConversation(conversationId: string, caller?: SubagentCaller): Promise<RemoveResult> {
    return this.removeConversations([conversationId], caller);
  }
  async removeConversations(ids: readonly string[], caller?: SubagentCaller): Promise<RemoveResult> {
    const unique = [...new Set(ids)];
    const removed: ConversationId[] = [];
    const removedConversations: Conversation[] = [];
    const errors: Array<{ conversationId: string; error: string }> = [];
    const candidates: Conversation[] = [];
    for (const id of unique) {
      const conversation = this.conversations.get(id as ConversationId);
      if (!conversation) { errors.push({ conversationId: id, error: `Unknown subagent: ${id}.` }); continue; }
      try {
        this.assertCallerAccess(conversation.conversationId, caller, "remove");
        candidates.push(conversation);
      } catch (error) {
        errors.push({ conversationId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const requested = new Set(candidates.map(conversation => conversation.conversationId));
    const roots = candidates.filter(conversation => {
      let parentId = conversation.parentConversationId;
      while (parentId) {
        if (requested.has(parentId)) return false;
        parentId = this.conversations.get(parentId)?.parentConversationId;
      }
      return true;
    });
    for (const root of roots) {
      const subtree = this.conversationSubtree(root.conversationId);
      const active = subtree.filter(conversation => conversation.lifecycleState === "active");
      if (active.length) {
        const error = `Subagent subtree ${root.conversationId} has active subagents: ${active.map(conversation => conversation.conversationId).join(", ")}. Cancel them before removal.`;
        for (const target of candidates) {
          if (subtree.includes(target)) errors.push({ conversationId: target.conversationId, error });
        }
        continue;
      }
      for (const conversation of [...subtree].reverse()) {
        this.conversations.delete(conversation.conversationId);
        for (const run of conversation.runHistory) this.runs.delete(run.runId);
        removed.push(conversation.conversationId);
        removedConversations.push(conversation);
      }
    }
    for (const conversation of removedConversations) {
      for (const listener of [...this.listeners]) {
        try { listener(conversation, "removed"); } catch {}
      }
    }
    const inputOrder = new Map(unique.map((id, index) => [id, index]));
    errors.sort((left, right) => (inputOrder.get(left.conversationId) ?? unique.length) - (inputOrder.get(right.conversationId) ?? unique.length));
    return { removed: removed.length, conversationIds: removed, errors };
  }
  private conversationSubtree(rootId: ConversationId): Conversation[] {
    const result: Conversation[] = [];
    const visit = (conversation: Conversation) => {
      result.push(conversation);
      for (const child of this.conversations.values()) {
        if (child.parentConversationId === conversation.conversationId) visit(child);
      }
    };
    visit(this.requireConversation(rootId));
    return result;
  }
  private requireConversation(id: string): Conversation { const found = this.conversations.get(id as ConversationId); if (!found) throw new Error(`Unknown conversation: ${id}.`); return found; }
  private resumeError(agent: Conversation): string {
    if (agent.isStopping) {
      return `Subagent ${agent.conversationId} is still settling a cancelled execution. Wait for it to finish before resuming.`;
    }
    return `Subagent ${agent.conversationId} cannot be resumed.`;
  }
  private capacityError(): string { const removable = [...this.conversations.values()].filter(a => a.lifecycleState !== "active").map(a => a.conversationId); return `Subagent capacity (${this.maxConversations}) reached. Remove terminal subagents${removable.length ? `: ${removable.join(", ")}` : " before spawning more"}.`; }
  private withDeferredUpdates<T>(operation: () => T): T {
    this.updateDeferralDepth++;
    try {
      return operation();
    } finally {
      this.updateDeferralDepth--;
      if (this.updateDeferralDepth === 0) {
        const pending = [...this.deferredUpdates].flatMap(([agent, kinds]) => [...kinds].map(kind => ({ agent, kind })));
        this.deferredUpdates.clear();
        for (const { agent, kind } of pending) this.updated(agent, kind);
      }
    }
  }
  private updated(agent: Conversation, kind: ConversationUpdateKind): void {
    if (this.conversations.get(agent.conversationId) !== agent) return;
    if (this.updateDeferralDepth > 0) {
      const kinds = this.deferredUpdates.get(agent) ?? new Set<ConversationUpdateKind>();
      kinds.add(kind);
      this.deferredUpdates.set(agent, kinds);
      return;
    }
    for (const listener of this.listeners) listener(agent, kind);
  }
}
