import type { AgentSessionEvent, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentRegistry, resolveRequestedConfig } from "./agents.js";
import { Conversation, errorRun, interruptedRun, skippedRun, type ConversationSnapshot, type ConversationUpdateKind, type NestedJoinTargetSnapshot, type ParentRun, type Run, type RunSnapshot, type SteerReceipt } from "./conversation.js";
import { DEFAULT_EXECUTE_RUN_DEPENDENCIES, executeRun, resolveModel, resolveTaskCwd } from "./execute.js";
import { ConversationIdAllocator, RunIdAllocator, type ConversationId, type RunId } from "./identifiers.js";
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
      const end = timingStart(`manager.${kind}Task`, { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parent?.conversationId });
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
    }, { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parent?.conversationId, kind });
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
export interface RunIdentity { readonly runId: RunId; readonly conversationId: ConversationId; readonly parentRunId?: RunId }
export interface RunLineage { readonly parentRunId?: RunId; readonly rootRunId: RunId; readonly depth: number }
export interface ConversationDisplayIdentity { readonly conversationId: ConversationId; readonly label?: string; readonly agentName?: string }
export interface RemoveResult { removed: number; conversationIds: ConversationId[]; errors: Array<{ conversationId: string; error: string }> }
export interface CancelResult { readonly conversationId: ConversationId; readonly runId: RunId; readonly status: "aborted" }
export interface SteerResult { readonly conversationId: ConversationId; readonly runId: RunId; readonly steer: SteerReceipt }
export interface InspectedRun { readonly conversationId: ConversationId; readonly snapshot: RunSnapshot }

type JoinStatus = ConversationSnapshot["runs"][number]["status"];
type RunRecord = {
  readonly runId: RunId;
  readonly conversationId: ConversationId;
  /** Current ownership parent; contracted across removed conversations. */
  readonly parentRunId?: RunId;
  readonly agent: Conversation;
};
interface BoundRun { readonly runId: RunId; snapshot(): { readonly status: JoinStatus }; acknowledge(): void; release(): void }
interface BoundRecord { readonly conversationId: ConversationId; readonly parentRunId?: RunId; readonly binding: BoundRun }

/** Owns retained conversations and their exact-run records. */
export class SubagentRuntime {
  private readonly conversations = new Map<ConversationId, Conversation>();
  private readonly runs = new Map<RunId, RunRecord>();
  private readonly listeners = new Set<ConversationUpdateListener>();
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
  conversation(conversationId: string): ConversationSnapshot { return this.requireConversation(conversationId).snapshot(); }

  /** Resolves and reserves the complete batch synchronously; executions never inherit caller cancellation. */
  startRun(ctx: ExtensionContext, tasks: readonly (SpawnRequest | ResumeRequest)[], options: { parent?: ParentRun } = {}): RunHandle {
    const starts: OrderedStartOutcome[] = [];
    const executions: Promise<unknown>[] = [];
    let reserved = this.conversations.size;
    for (let inputIndex = 0; inputIndex < tasks.length; inputIndex++) {
      const task = tasks[inputIndex];
      let agent: Conversation | undefined;
      let runId: RunId | undefined;
      let error: string | undefined;
      if (task.kind === "spawn") {
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
            else { agent = new Conversation(conversationId, runId, config, task, (a, k) => this.updated(a, k), options); this.conversations.set(conversationId, agent); reserved++; }
          }
        }
      } else {
        agent = this.conversations.get(task.conversationId);
        if (!agent) error = `Unknown conversation: ${task.conversationId}.`;
        else if (agent.hasCurrentRun) {
          const status = agent.status.kind;
          if (status === "running") error = `Conversation ${task.conversationId} has running run ${agent.latestRunId}. Join it before resuming, or steer it while it runs.`;
          else if (status === "queued") error = `Conversation ${task.conversationId} has queued run ${agent.latestRunId}. Wait for or join it before resuming.`;
          else error = `Conversation ${task.conversationId} cannot be resumed.`;
        }
        else if (!agent.canResume) error = this.resumeError(agent);
        else { runId = this.runIds.allocate(); if (!runId) error = "Run ID space exhausted."; else agent.beginResume(runId, task.prompt); }
      }
      if (!agent || !runId || error) { starts.push({ ok: false, inputIndex, error: error ?? "Could not start run." }); continue; }
      this.runs.set(runId, {
        runId, conversationId: agent.conversationId, agent,
        ...(task.kind === "spawn" && options.parent ? { parentRunId: options.parent.runId } : {}),
      });
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

  async steerRun(runId: RunId, prompt: string, owner?: ParentRun): Promise<SteerResult> {
    const record = this.requireRunRecord(runId);
    this.assertOwnerAccess(record, owner, "steer");
    const steer = await record.agent.steer(runId, prompt);
    return { conversationId: record.conversationId, runId, steer };
  }

  async cancelRun(runId: RunId, owner?: ParentRun): Promise<CancelResult> {
    const record = this.requireRunRecord(runId);
    this.assertOwnerAccess(record, owner, "cancel");
    const run = this.runSnapshot(runId);
    if (run.status.kind === "done") {
      throw new Error(`Run ${runId} is ${run.status.outcome} and cannot be cancelled.`);
    }
    const wasQueued = run.status.kind === "queued";
    const aborting = record.agent.abort("Run cancelled.");
    if (wasQueued) {
      const aborted = record.agent.runHistory.find(item => item.runId === runId)!;
      this._scheduler.cancelQueued(runId, aborted);
    }
    await aborting;
    return { conversationId: record.conversationId, runId, status: "aborted" };
  }

  inspectRuns(runIds: readonly RunId[], owner?: ParentRun): InspectedRun[] {
    return runIds.map(runId => {
      const record = this.requireRunRecord(runId);
      this.assertOwnerAccess(record, owner, "inspect");
      return { conversationId: record.conversationId, snapshot: this.runSnapshot(runId) };
    });
  }

  /** Binds only the requested runs. Resolution and observer attachment are all-or-nothing. */
  bindJoin(runIds: readonly RunId[]): JoinBinding {
    const records = runIds.map(id => { const record = this.runs.get(id); if (!record) throw new Error(`Unknown run: ${id}.`); return record; });
    return this.bindRecords(records);
  }

  /** Records and binds one nested join attempt on its exact owner run. */
  bindNestedJoin(owner: ParentRun, runIds: readonly RunId[], toolCallId?: string): NestedJoinBinding {
    const ownerRecord = this.runs.get(owner.runId);
    if (!ownerRecord || ownerRecord.conversationId !== owner.conversationId)
      throw new Error(`Unknown join owner run: ${owner.runId}.`);
    const attemptIndex = ownerRecord.agent.beginNestedJoin(owner.runId, runIds, toolCallId);
    let records: RunRecord[];
    try {
      records = runIds.map(id => {
        const record = this.runs.get(id);
        if (!record) throw new Error(`Unknown run: ${id}.`);
        if (!this.isDescendant(record.runId, owner.runId)) throw new Error(`Run ${id} is not a descendant of owner run ${owner.runId}.`);
        return record;
      });
    } catch (error) {
      this.updateNestedJoin(owner.runId, attemptIndex, { state: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const base = this.bindRecords(records);
    let terminal = false;
    const targets = (): NestedJoinTargetSnapshot[] => base.project().map(value => ({
      runId: value.runId, conversationId: value.conversationId,
      status: value.status.kind === "done" ? value.status.outcome : value.status.kind,
    }));
    this.updateNestedJoin(owner.runId, attemptIndex, { targets: targets() });
    void base.completion.then(() => {
      if (terminal) return; terminal = true;
      this.updateNestedJoin(owner.runId, attemptIndex, { targets: targets(), state: "completed" });
    });
    return {
      ownerRunId: owner.runId, attemptIndex,
      get runIds() { return base.runIds; }, completion: base.completion,
      project: () => base.project(), acknowledge: () => base.acknowledge(), release: () => base.release(),
      interrupt: (error = "Nested join interrupted.") => {
        if (terminal) return; terminal = true;
        this.updateNestedJoin(owner.runId, attemptIndex, { targets: targets(), state: "interrupted", error });
        base.release();
      },
    };
  }

  runSnapshot(runId: RunId): RunSnapshot {
    const record = this.requireRunRecord(runId);
    return record.agent.runHistory.find(run => run.runId === runId)!;
  }
  runLineage(runId: RunId): RunLineage {
    const record = this.requireRunRecord(runId);
    let current = record;
    let depth = 0;
    const seen = new Set<RunId>([runId]);
    while (current.parentRunId) {
      const parent = this.requireRunRecord(current.parentRunId);
      if (seen.has(parent.runId)) break;
      seen.add(parent.runId);
      current = parent;
      depth++;
    }
    return {
      ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
      rootRunId: current.runId,
      depth,
    };
  }
  conversationDisplay(conversationId: ConversationId): ConversationDisplayIdentity {
    const live = this.conversations.get(conversationId);
    if (live) return { conversationId, ...(live.label ? { label: live.label } : {}), agentName: live.agentName };
    throw new Error(`Unknown conversation: ${conversationId}.`);
  }
  directSpawnedChildren(runId: RunId): readonly RunIdentity[] {
    return [...this.runs.values()].filter(value => value.parentRunId === runId).map(value => ({ runId: value.runId, conversationId: value.conversationId, parentRunId: runId }));
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
        attached.push({ conversationId: record.conversationId, binding, ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}) });
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

  private assertOwnerAccess(record: RunRecord, owner: ParentRun | undefined, action: string): void {
    if (!owner) return;
    const ownerRecord = this.runs.get(owner.runId);
    if (!ownerRecord || ownerRecord.conversationId !== owner.conversationId) {
      throw new Error(`Unknown ${action} owner run: ${owner.runId}.`);
    }
    if (!this.isDescendant(record.runId, owner.runId)) {
      throw new Error(`Run ${record.runId} is not a descendant of owner run ${owner.runId}.`);
    }
  }

  private isDescendant(candidate: RunId, owner: RunId): boolean {
    let current = this.runs.get(candidate);
    const seen = new Set<RunId>();
    while (current?.parentRunId && !seen.has(current.runId)) {
      if (current.parentRunId === owner) return true;
      seen.add(current.runId); current = this.runs.get(current.parentRunId);
    }
    return false;
  }
  private requireRunRecord(runId: RunId): RunRecord { const record = this.runs.get(runId); if (!record) throw new Error(`Unknown run: ${runId}.`); return record; }

  removeConversation(conversationId: string): Promise<RemoveResult> { return this.removeConversations([conversationId]); }
  async removeConversations(ids: readonly string[]): Promise<RemoveResult> {
    const unique = [...new Set(ids)]; const removed: ConversationId[] = []; const errors: Array<{ conversationId: string; error: string }> = [];
    for (const id of unique) {
      const agent = this.conversations.get(id as ConversationId);
      if (!agent) { errors.push({ conversationId: id, error: `Unknown conversation: ${id}.` }); continue; }
      if (agent.hasCurrentRun) {
        errors.push({
          conversationId: id,
          error: `Conversation ${id} has active run ${agent.latestRunId}. Cancel and join it before removal.`,
        });
        continue;
      }
      this.contractOwnership(agent);
      this.conversations.delete(agent.conversationId);
      for (const run of agent.runHistory) this.runs.delete(run.runId);
      removed.push(agent.conversationId);
    }
    return { removed: removed.length, conversationIds: removed, errors };
  }
  private contractOwnership(agent: Conversation): void {
    const removedRunIds = new Set(agent.runHistory.map(run => run.runId));
    for (const [runId, record] of this.runs) {
      if (!record.parentRunId || !removedRunIds.has(record.parentRunId) || removedRunIds.has(runId)) continue;
      const replacementParentRunId = this.runs.get(record.parentRunId)?.parentRunId;
      const replacementParent = replacementParentRunId
        ? this.runs.get(replacementParentRunId)
        : undefined;
      const { parentRunId: _, ...child } = record;
      this.runs.set(runId, replacementParentRunId ? { ...child, parentRunId: replacementParentRunId } : child);
      record.agent.reparent(replacementParent
        ? { conversationId: replacementParent.conversationId, runId: replacementParent.runId }
        : undefined);
    }
  }
  private requireConversation(id: string): Conversation { const found = this.conversations.get(id as ConversationId); if (!found) throw new Error(`Unknown conversation: ${id}.`); return found; }
  private resumeError(agent: Conversation): string {
    if (agent.isStopping) {
      return `Conversation ${agent.conversationId} is still settling cancelled run ${agent.latestRunId}. Wait for it to finish before resuming.`;
    }
    return `Conversation ${agent.conversationId} cannot be resumed.`;
  }
  private capacityError(): string { const removable = [...this.conversations.values()].filter(a => !a.hasCurrentRun).map(a => a.conversationId); return `Conversation capacity (${this.maxConversations}) reached. Remove terminal conversations${removable.length ? `: ${removable.join(", ")}` : " before spawning more"}.`; }
  private updated(agent: Conversation, kind: ConversationUpdateKind): void {
    if (this.conversations.get(agent.conversationId) !== agent) return;
    for (const listener of this.listeners) listener(agent, kind);
  }
}
