import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentRegistry, resolveRequestedConfig } from "./agents.js";
import { Conversation, RunSteerError, effectiveStatus, type ConversationSnapshot, type ConversationUpdateKind, type ConversationUpdateListener, type NestedJoinTargetSnapshot, type RunBinding, type RunSnapshot, type RunViewStatus, type SteerReceipt } from "./conversation.js";
import { resolveModel, resolveRequestedSkills, resolveTaskCwd } from "./execute.js";
import { ConversationIdAllocator, RunIdAllocator, type ConversationId, type RunId, type RunRef, type SubagentId } from "./identifiers.js";
import { RunScheduler, type RunExecutor } from "./scheduler.js";
import { projectLiveSubagent, projectSubagentRunStatus, type CanonicalLiveSubagent, type FailureProjectionMode } from "./contract.js";
import type { SpawnRequest, ResumeRequest } from "./schema.js";

export type { ConversationUpdateListener } from "./conversation.js";

export class SubagentNotFoundError extends Error {
  constructor(readonly subagentId: string) {
    super(`Subagent ${subagentId} was not found.`);
    this.name = "SubagentNotFoundError";
  }
}

export type OrderedStartOutcome =
  | ({ readonly ok: true; readonly inputIndex: number; readonly steer?: SteerReceipt } & RunRef)
  | { readonly ok: false; readonly inputIndex: number; readonly error: string };
export interface RunHandle { readonly starts: readonly OrderedStartOutcome[]; readonly completion: Promise<readonly OrderedStartOutcome[]> }
export interface JoinProjection extends RunRef { readonly status: RunViewStatus }
export interface JoinBinding { readonly runIds: readonly RunId[]; readonly completion: Promise<void>; project(): readonly JoinProjection[]; markJoined(): void; release(): void }
export interface NestedJoinBinding extends JoinBinding { readonly ownerRunId: RunId; readonly attemptIndex: number; interrupt(error?: string): void }
export type SubagentCaller = RunRef;
export interface ConversationDisplayIdentity { readonly conversationId: ConversationId; readonly label?: string; readonly agentName?: string }
export type RemoveOutcome =
  | { readonly ok: true; readonly conversationId: ConversationId; readonly label: string; readonly removedIds: readonly ConversationId[] }
  | { readonly ok: false; readonly conversationId: string; readonly error: string };
export interface SteerResult extends RunRef { readonly steer: SteerReceipt }

type RunRecord = RunRef & {
  readonly agent: Conversation;
};
interface BoundRecord { readonly conversationId: ConversationId; readonly binding: RunBinding }
type Reservation = { readonly agent: Conversation; readonly runId: RunId } | { readonly error: string };

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

  constructor(
    readonly registry: AgentRegistry,
    maxRunning = 4,
    executor?: RunExecutor,
    private _maxConversations = 100,
    private readonly cancellationSettlementMs = 5_000,
  ) {
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
  queryConversations(callerConversationId?: ConversationId): ConversationSnapshot[] {
    return [...this.conversations.values()]
      .filter(conversation => conversation.parentConversationId === callerConversationId)
      .map(conversation => conversation.snapshot());
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
  projectSubagent(
    conversationId: string,
    caller?: SubagentCaller,
    failureMode: FailureProjectionMode = "full",
  ): CanonicalLiveSubagent {
    const conversation = this.requireConversation(conversationId);
    const latest = conversation.runHistory.at(-1)!;
    const directlyOwned = caller
      ? conversation.parentConversationId === caller.conversationId
      : conversation.parentConversationId === undefined;
    const removableSubtree = this.conversationSubtree(conversation.conversationId)
      .every(item => !item.hasActiveExecution);
    return projectLiveSubagent({
      subagentId: conversation.conversationId,
      label: conversation.label,
      agent: conversation.agentName,
      runStatus: latest.status,
      joined: latest.joined,
      directlyOwned,
      resumeAllowed: conversation.isResumeAllowed,
      removableSubtree,
    }, failureMode);
  }

  /** Resolves and reserves the complete batch synchronously; executions never inherit caller cancellation. */
  startRun(ctx: ExtensionContext, tasks: readonly (SpawnRequest | ResumeRequest)[], options: { caller?: SubagentCaller } = {}): RunHandle {
    const starts: OrderedStartOutcome[] = [];
    const executions: Promise<unknown>[] = [];
    const caller = options.caller;
    let callerError: string | undefined;
    if (caller) {
      try { this.requireCallerRecord(caller, "start"); }
      catch (error) { callerError = error instanceof Error ? error.message : String(error); }
    }
    for (let inputIndex = 0; inputIndex < tasks.length; inputIndex++) {
      const task = tasks[inputIndex];
      const reservation: Reservation = callerError ? { error: callerError }
        : task.kind === "spawn" ? this.reserveSpawn(ctx, task, caller)
        : this.reserveResume(task, caller);
      if ("error" in reservation) {
        starts.push({
          ok: false,
          inputIndex,
          error: reservation.error,
        });
        continue;
      }
      const { agent, runId } = reservation;
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

  private reserveSpawn(ctx: ExtensionContext, task: SpawnRequest, caller?: SubagentCaller): Reservation {
    const config = this.registry.agents.get(task.agent);
    if (!config) return { error: `Unknown agent: ${task.agent}.` };
    const requested = resolveRequestedConfig(config, task);
    const model = resolveModel(requested.model, ctx.model, ctx.modelRegistry);
    if (!model.ok) return { error: model.error };
    const cwd = resolveTaskCwd(ctx.cwd, requested.cwd);
    if (!cwd.ok) return { error: cwd.error };
    const skills = resolveRequestedSkills(cwd.value, requested.skills ?? []);
    if (!skills.ok) return { error: skills.error };
    if (this.conversations.size >= this.maxConversations) return { error: this.capacityError() };
    const conversationId = this.conversationIds.allocate();
    const runId = this.runIds.allocate();
    if (!conversationId || !runId) return { error: "Conversation or run ID space exhausted." };
    const agent = new Conversation(conversationId, runId, config, task, (a, k) => this.updated(a, k),
      caller ? { parentConversationId: caller.conversationId, spawnedByRunId: caller.runId } : {});
    this.conversations.set(conversationId, agent);
    return { agent, runId };
  }

  private reserveResume(task: ResumeRequest, caller?: SubagentCaller): Reservation {
    const subagentId = task.subagentId;
    const agent = subagentId ? this.conversations.get(subagentId) : undefined;
    if (!agent) {
      return { error: new SubagentNotFoundError(String(subagentId)).message };
    }
    if (caller && agent.parentConversationId !== caller.conversationId) {
      return { error: `Subagent ${agent.conversationId} is not directly owned by caller subagent ${caller.conversationId}.` };
    }
    if (!caller && agent.parentConversationId) {
      return { error: `Subagent ${agent.conversationId} is not directly owned by the root agent.` };
    }
    if (agent.hasCurrentRun) {
      const status = agent.status.kind;
      if (status === "running") return { error: `Subagent ${subagentId} is running. Join it before resuming, or steer it while it runs.` };
      if (status === "queued") return { error: `Subagent ${subagentId} is queued. Wait for or join it before resuming.` };
      return { error: `Subagent ${subagentId} cannot be resumed.` };
    }
    if (!agent.isResumeAllowed) return { error: this.resumeError(agent) };
    const runId = this.runIds.allocate();
    if (!runId) return { error: "Run ID space exhausted." };
    agent.beginResume(runId, task.prompt);
    return { agent, runId };
  }

  async steerSubagent(subagentId: SubagentId, prompt: string, caller?: SubagentCaller): Promise<SteerResult> {
    const record = this.latestSubagentRecord(subagentId);
    this.assertDirectOwner(record.agent, caller, "steer");
    try {
      const steer = await record.agent.steer(record.runId, prompt);
      return { conversationId: record.conversationId, runId: record.runId, steer };
    } catch (error) {
      if (error instanceof RunSteerError) {
        const status = error.status === "stopping" ? "cancelled" : projectSubagentRunStatus(error.status);
        throw new Error(`Subagent ${subagentId} is ${status} and cannot be steered.`);
      }
      throw error;
    }
  }

  async cancelSubagent(subagentId: SubagentId, caller?: SubagentCaller): Promise<RunRef> {
    const record = this.latestSubagentRecord(subagentId);
    this.assertDirectOwner(record.agent, caller, "cancel");
    const run = this.runSnapshot(record.runId);
    if (run.status.kind === "done") {
      throw new Error(`Subagent ${subagentId} is ${projectSubagentRunStatus(run.status.outcome)} and cannot be cancelled.`);
    }
    const wasQueued = run.status.kind === "queued";
    void record.agent.abort("Run cancelled.");
    if (wasQueued) {
      const cancelled = record.agent.runHistory.find(item => item.runId === record.runId)!;
      this._scheduler.cancelQueued(record.runId, cancelled);
    }
    const settled = await this.waitForCancellationSettlement(record.agent);
    if (!settled) {
      const cancelled = record.agent.forceAbandonCancellation(record.runId);
      this._scheduler.abandon(record.runId, cancelled);
    }
    return { conversationId: record.conversationId, runId: record.runId };
  }

  inspectSubagents(subagentIds: readonly SubagentId[], caller?: SubagentCaller): Array<{ readonly conversationId: ConversationId; readonly snapshot: RunSnapshot }> {
    return subagentIds.map(subagentId => {
      const record = this.latestSubagentRecord(subagentId);
      this.assertDirectOwner(record.agent, caller, "inspect");
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
    const ownerRecord = this.requireCallerRecord(caller, "join");
    const attemptIndex = ownerRecord.agent.beginNestedJoin(caller.runId, runIds, toolCallId);
    let records: RunRecord[];
    try {
      records = runIds.map(id => {
        const record = this.runs.get(id);
        if (!record) throw new Error(`Unknown run: ${id}.`);
        this.assertDirectOwner(record.agent, caller, "join");
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
      status: effectiveStatus(value.status),
    }));
    this.updateNestedJoin(caller.runId, attemptIndex, { targets: targets() });
    void base.completion.then(() => {
      if (terminal) return; terminal = true;
      this.updateNestedJoin(caller.runId, attemptIndex, { targets: targets(), state: "completed" });
    });
    return {
      ownerRunId: caller.runId, attemptIndex,
      get runIds() { return base.runIds; }, completion: base.completion,
      project: () => base.project(), markJoined: () => base.markJoined(), release: () => base.release(),
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
    const live = this.requireConversation(conversationId);
    return { conversationId, label: live.label, agentName: live.agentName };
  }
  directSpawnedChildren(runId: RunId): readonly RunRef[] {
    return [...this.conversations.values()]
      .filter(conversation => conversation.spawnedByRunId === runId)
      .map(conversation => ({ runId: conversation.runHistory[0].runId, conversationId: conversation.conversationId }));
  }
  unjoinedDirectChildren(runId: RunId): readonly RunRef[] {
    const mentioned = new Set((this.runSnapshot(runId).nestedJoins ?? []).flatMap(attempt => attempt.targets.map(target => target.runId)));
    return this.directSpawnedChildren(runId).filter(child => !mentioned.has(child.runId));
  }

  private bindRecords(records: readonly RunRecord[]): JoinBinding {
    const attached: BoundRecord[] = [];
    try {
      for (const record of records) {
        attached.push({ conversationId: record.conversationId, binding: record.agent.bindRun(record.runId) });
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
      markJoined: () => { for (const item of attached) if (item.binding.snapshot().status.kind === "done") item.binding.markJoined(); },
      release: () => { if (released) return; released = true; unsubscribe(); for (const item of attached) item.binding.release(); },
    };
  }
  private updateNestedJoin(runId: RunId, index: number, update: { targets?: readonly NestedJoinTargetSnapshot[]; state?: "running" | "completed" | "failed" | "interrupted"; error?: string }): void {
    const record = this.runs.get(runId);
    if (!record) return;
    record.agent.updateNestedJoin(runId, index, update);
  }

  /** Callers must act through their own live run; otherwise the caller is stale. */
  private requireCallerRecord(caller: SubagentCaller, action: string): RunRecord {
    const record = this.runs.get(caller.runId);
    if (!record || record.conversationId !== caller.conversationId) {
      throw new Error(`${action[0].toUpperCase()}${action.slice(1)} caller is no longer active.`);
    }
    return record;
  }

  private assertDirectOwner(target: Conversation, caller: SubagentCaller | undefined, action: string): void {
    if (caller) {
      this.requireCallerRecord(caller, action);
      if (target.parentConversationId !== caller.conversationId) {
        throw new Error(`Subagent ${target.conversationId} is not directly owned by caller subagent ${caller.conversationId}.`);
      }
      return;
    }
    if (target.parentConversationId) {
      throw new Error(`Subagent ${target.conversationId} is not directly owned by the root agent.`);
    }
  }

  private latestSubagentRecord(subagentId: SubagentId): RunRecord {
    const agent = this.requireConversation(subagentId);
    return this.requireRunRecord(agent.latestRunId);
  }

  private requireRunRecord(runId: RunId): RunRecord { const record = this.runs.get(runId); if (!record) throw new Error(`Unknown run: ${runId}.`); return record; }

  async removeConversation(conversationId: string, caller?: SubagentCaller): Promise<RemoveOutcome> {
    return (await this.removeConversations([conversationId], caller))[0];
  }
  async removeConversations(ids: readonly string[], caller?: SubagentCaller): Promise<RemoveOutcome[]> {
    const unique = [...new Set(ids)];
    const failures = new Map<string, Extract<RemoveOutcome, { ok: false }>>();
    const candidates: Conversation[] = [];
    for (const id of unique) {
      const conversation = this.conversations.get(id as ConversationId);
      if (!conversation) {
        failures.set(id, { ok: false, conversationId: id, error: new SubagentNotFoundError(id).message });
        continue;
      }
      try {
        this.assertDirectOwner(conversation, caller, "remove");
        candidates.push(conversation);
      } catch (error) {
        failures.set(id, { ok: false, conversationId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const candidateSubtrees = new Map(candidates.map(conversation => [
      conversation.conversationId,
      this.conversationSubtree(conversation.conversationId),
    ]));
    const requested = new Set(candidates.map(conversation => conversation.conversationId));
    const roots = candidates.filter(conversation => {
      let parentId = conversation.parentConversationId;
      while (parentId) {
        if (requested.has(parentId)) return false;
        parentId = this.conversations.get(parentId)?.parentConversationId;
      }
      return true;
    });
    const removed = new Set<ConversationId>();
    const removedConversations: Conversation[] = [];
    for (const root of roots) {
      const subtree = candidateSubtrees.get(root.conversationId)!;
      const active = subtree.filter(conversation => conversation.hasActiveExecution);
      if (active.length) {
        const error = `Subagent subtree ${root.conversationId} has active subagents: ${active.map(conversation => conversation.conversationId).join(", ")}. Cancel them before removal.`;
        for (const target of candidates) {
          if (subtree.includes(target)) failures.set(target.conversationId, { ok: false, conversationId: target.conversationId, error });
        }
        continue;
      }
      for (const conversation of [...subtree].reverse()) {
        this.conversations.delete(conversation.conversationId);
        for (const run of conversation.runHistory) this.runs.delete(run.runId);
        removed.add(conversation.conversationId);
        removedConversations.push(conversation);
      }
    }
    for (const conversation of removedConversations) {
      for (const listener of [...this.listeners]) {
        try { listener(conversation, "removed"); } catch {}
      }
    }
    return unique.map(id => {
      const failure = failures.get(id);
      if (failure) return failure;
      const conversation = candidates.find(item => item.conversationId === id)!;
      const removedIds = candidateSubtrees.get(conversation.conversationId)!
        .map(item => item.conversationId)
        .filter(itemId => removed.has(itemId))
        .reverse();
      return removedIds.length
        ? { ok: true as const, conversationId: conversation.conversationId, label: conversation.label, removedIds }
        : { ok: false as const, conversationId: id, error: `Subagent ${id} was not removed.` };
    });
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
  private requireConversation(id: string): Conversation {
    const found = this.conversations.get(id as ConversationId);
    if (!found) throw new SubagentNotFoundError(id);
    return found;
  }
  private waitForCancellationSettlement(agent: Conversation): Promise<boolean> {
    if (!agent.isStopping) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const finish = (settled: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(settled);
      };
      const unsubscribe = this.onConversationUpdate(updated => {
        if (updated === agent && !agent.isStopping) finish(true);
      });
      const timer = setTimeout(() => finish(false), this.cancellationSettlementMs);
      if (!agent.isStopping) finish(true);
    });
  }
  private resumeError(agent: Conversation): string {
    if (agent.isStopping) {
      return `Subagent ${agent.conversationId} is still settling a cancelled execution. Wait for it to finish before resuming.`;
    }
    return `Subagent ${agent.conversationId} cannot be resumed.`;
  }
  private capacityError(): string { const removable = [...this.conversations.values()].filter(a => !a.hasActiveExecution).map(a => a.conversationId); return `Subagent capacity (${this.maxConversations}) reached. Remove inactive subagents${removable.length ? `: ${removable.join(", ")}` : " before spawning more"}.`; }
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
