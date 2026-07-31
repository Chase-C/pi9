import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentRegistry, resolveRequestedConfig } from "./agents.js";
import {
  Conversation,
  GenerationSteerError,
  effectiveStatus,
  generationKey,
  type ConversationSnapshot,
  type ConversationUpdateKind,
  type ConversationUpdateListener,
  type Generation,
  type GenerationBinding,
  type GenerationRef,
  type GenerationSnapshot,
  type GenerationViewStatus,
  type NestedJoinTargetSnapshot,
  type SteerReceipt,
} from "./conversation.js";
import { resolveModel, resolveRequestedSkills, resolveTaskCwd } from "./execute.js";
import { ConversationIdAllocator, type ConversationId, type SubagentId } from "./identifiers.js";
import { GenerationScheduler, type GenerationExecutor } from "./scheduler.js";
import { projectLiveSubagent, projectSubagentGenerationStatus, projectSubagentStatus, type CanonicalLiveSubagent, type FailureProjectionMode } from "./contract.js";
import type { SubagentStatus, SpawnRequest, ResumeRequest } from "./schema.js";

export type { ConversationUpdateListener } from "./conversation.js";

export class SubagentNotFoundError extends Error {
  constructor(readonly subagentId: string) { super(`Subagent ${subagentId} was not found.`); this.name = "SubagentNotFoundError"; }
}

export type OrderedStartOutcome =
  | ({ readonly ok: true; readonly inputIndex: number; readonly steer?: SteerReceipt } & GenerationRef)
  | { readonly ok: false; readonly inputIndex: number; readonly error: string };
export interface GenerationHandle { readonly starts: readonly OrderedStartOutcome[]; readonly completion: Promise<readonly OrderedStartOutcome[]> }
export interface JoinProjection extends GenerationRef { readonly status: GenerationViewStatus }
export interface JoinBinding {
  readonly targets: readonly GenerationRef[];
  readonly completion: Promise<void>;
  project(): readonly JoinProjection[];
  markJoined(): void;
  release(): void;
}
export interface NestedJoinBinding extends JoinBinding {
  readonly owner: GenerationRef;
  readonly attemptIndex: number;
  interrupt(error?: string): void;
}
export interface SubagentCaller { readonly conversation: Conversation; readonly generation: Generation }
export interface ConversationDisplayIdentity { readonly conversationId: ConversationId; readonly label?: string; readonly agentName?: string }
export type RemoveOutcome =
  | { readonly ok: true; readonly conversationId: ConversationId; readonly label: string; readonly removedIds: readonly ConversationId[] }
  | { readonly ok: false; readonly conversationId: string; readonly error: string };
export interface SteerResult extends GenerationRef { readonly steer: SteerReceipt }

interface GenerationRecord { readonly conversation: Conversation; readonly generation: Generation }
interface BoundRecord { readonly conversationId: ConversationId; readonly binding: GenerationBinding }
type Reservation = GenerationRecord | { readonly error: string };

/** Owns retained conversations. Generations are addressed internally by their object identity. */
export class SubagentRuntime {
  private readonly conversations = new Map<ConversationId, Conversation>();
  private readonly listeners = new Set<ConversationUpdateListener>();
  private readonly deferredUpdates = new Map<Conversation, Set<ConversationUpdateKind>>();
  private updateDeferralDepth = 0;
  private readonly conversationIds = new ConversationIdAllocator();
  private readonly executionScheduler: GenerationScheduler;

  constructor(
    readonly registry: AgentRegistry,
    maxExecuting = 4,
    executor?: GenerationExecutor,
    private maximumConversations = 100,
    private readonly cancellationSettlementMs = 5_000,
  ) {
    this.executionScheduler = new GenerationScheduler({ maxExecuting, ...(executor ? { executor } : {}), isTracked: conversation => this.conversations.get(conversation.conversationId) === conversation });
  }

  get scheduler(): GenerationScheduler { return this.executionScheduler; }
  get maxConversations(): number { return this.maximumConversations; }
  configure(options: { maxExecuting?: number; maxConversations?: number }): void {
    this.executionScheduler.configure(options);
    if (options.maxConversations !== undefined) this.maximumConversations = options.maxConversations;
  }
  onConversationUpdate(listener: ConversationUpdateListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  listConversations(): ConversationSnapshot[] { return [...this.conversations.values()].map(conversation => conversation.snapshot()); }
  queryConversations(callerConversationId?: ConversationId): ConversationSnapshot[] {
    return [...this.conversations.values()].filter(conversation => conversation.parentConversationId === callerConversationId).map(conversation => conversation.snapshot());
  }
  conversationDepth(conversationId: ConversationId, callerConversationId?: ConversationId): number {
    let current = this.requireConversation(conversationId);
    let depth = 1;
    const seen = new Set<ConversationId>();
    while (current.parentConversationId !== callerConversationId) {
      if (!current.parentConversationId || seen.has(current.conversationId)) throw new Error(`Conversation ${conversationId} is outside the requested conversation tree.`);
      seen.add(current.conversationId);
      current = this.requireConversation(current.parentConversationId);
      depth++;
    }
    return depth;
  }
  conversation(conversationId: string): ConversationSnapshot { return this.requireConversation(conversationId).snapshot(); }
  subagentStatus(conversationId: string): SubagentStatus { return projectSubagentStatus(this.requireConversation(conversationId).generationHistory.at(-1)!.status); }

  projectSubagent(conversationId: string, caller?: SubagentCaller, failureMode: FailureProjectionMode = "full"): CanonicalLiveSubagent {
    if (caller) this.requireCaller(caller, "inspect");
    const conversation = this.requireConversation(conversationId);
    const latest = conversation.generationHistory.at(-1)!;
    const directlyOwned = caller ? conversation.parentConversationId === caller.conversation.conversationId : conversation.parentConversationId === undefined;
    const inspectable = caller ? this.isDescendant(conversation, caller.conversation.conversationId) : true;
    const removableSubtree = this.conversationSubtree(conversation.conversationId).every(item => !item.hasActiveExecution);
    return projectLiveSubagent({
      subagentId: conversation.conversationId,
      label: conversation.label,
      agent: conversation.agentName,
      generation: latest.generation,
      generationStatus: latest.status,
      joined: latest.joined,
      directlyOwned,
      inspectable,
      resumeAllowed: conversation.isResumeAllowed,
      removableSubtree,
    }, failureMode);
  }

  /** Resolves and reserves the complete batch synchronously; executions never inherit caller cancellation. */
  startTasks(ctx: ExtensionContext, tasks: readonly (SpawnRequest | ResumeRequest)[], options: { caller?: SubagentCaller } = {}): GenerationHandle {
    const starts: OrderedStartOutcome[] = [];
    const executions: Promise<unknown>[] = [];
    const caller = options.caller;
    let callerError: string | undefined;
    if (caller) try { this.requireCaller(caller, "start"); } catch (error) { callerError = error instanceof Error ? error.message : String(error); }
    for (let inputIndex = 0; inputIndex < tasks.length; inputIndex++) {
      const task = tasks[inputIndex];
      const reservation: Reservation = callerError ? { error: callerError }
        : task.kind === "spawn" ? this.reserveSpawn(ctx, task, caller)
        : this.reserveResume(task, caller);
      if ("error" in reservation) { starts.push({ ok: false, inputIndex, error: reservation.error }); continue; }
      const { conversation, generation } = reservation;
      const execution = this.executionScheduler.schedule(ctx, undefined, conversation, generation).finally(() => conversation.executionSettled(generation));
      executions.push(execution);
      this.updated(conversation, "status");
      starts.push({ ok: true, inputIndex, conversationId: conversation.conversationId, generation: generation.number });
    }
    return { starts, completion: Promise.allSettled(executions).then(() => starts) };
  }

  private reserveSpawn(ctx: ExtensionContext, task: SpawnRequest, caller?: SubagentCaller): Reservation {
    const definition = this.registry.agents.get(task.agent);
    if (!definition) return { error: `Unknown agent: ${task.agent}.` };
    const requested = resolveRequestedConfig(definition, task);
    const model = resolveModel(requested.model, ctx.model, ctx.modelRegistry);
    if (!model.ok) return { error: model.error };
    const cwd = resolveTaskCwd(ctx.cwd, requested.cwd);
    if (!cwd.ok) return { error: cwd.error };
    const skills = resolveRequestedSkills(cwd.value, requested.skills ?? []);
    if (!skills.ok) return { error: skills.error };
    if (this.conversations.size >= this.maxConversations) return { error: this.capacityError() };
    const conversationId = this.conversationIds.allocate();
    if (!conversationId) return { error: "Conversation ID space exhausted." };
    const conversation = new Conversation(conversationId, definition, task, (changed, kind) => this.updated(changed, kind), {
      ...(caller ? { parentConversationId: caller.conversation.conversationId, startedInParentGeneration: caller.generation.number } : {}),
      resolvedSkillBlocks: skills.value,
    });
    this.conversations.set(conversationId, conversation);
    return { conversation, generation: conversation.latestGeneration };
  }

  private reserveResume(task: ResumeRequest, caller?: SubagentCaller): Reservation {
    const conversation = task.subagentId ? this.conversations.get(task.subagentId) : undefined;
    if (!conversation) return { error: new SubagentNotFoundError(String(task.subagentId)).message };
    if (caller && conversation.parentConversationId !== caller.conversation.conversationId) return { error: `Subagent ${conversation.conversationId} is not directly owned by caller subagent ${caller.conversation.conversationId}.` };
    if (!caller && conversation.parentConversationId) return { error: `Subagent ${conversation.conversationId} is not directly owned by the root agent.` };
    if (conversation.hasCurrentGeneration) {
      const status = conversation.status.kind;
      if (status === "running") return { error: `Subagent ${conversation.conversationId} is running. Join it before resuming, or steer it while it runs.` };
      if (status === "queued") return { error: `Subagent ${conversation.conversationId} is queued. Wait for or join it before resuming.` };
      return { error: `Subagent ${conversation.conversationId} cannot be resumed.` };
    }
    if (!conversation.isResumeAllowed) return { error: this.resumeError(conversation) };
    return { conversation, generation: conversation.beginResume(task.prompt, caller?.generation.number) };
  }

  async steerSubagent(subagentId: SubagentId, prompt: string, caller?: SubagentCaller): Promise<SteerResult> {
    const record = this.latestSubagentRecord(subagentId);
    this.assertDirectOwner(record.conversation, caller, "steer");
    try {
      const steer = await record.conversation.steer(record.generation, prompt);
      return { conversationId: record.conversation.conversationId, generation: record.generation.number, steer };
    } catch (error) {
      if (error instanceof GenerationSteerError) {
        const status = error.status === "stopping" ? "cancelled" : projectSubagentGenerationStatus(error.status);
        throw new Error(`Subagent ${subagentId} is ${status} and cannot be steered.`);
      }
      throw error;
    }
  }

  async cancelSubagent(subagentId: SubagentId, caller?: SubagentCaller): Promise<GenerationRef> {
    const record = this.latestSubagentRecord(subagentId);
    this.assertDirectOwner(record.conversation, caller, "cancel");
    const snapshot = record.conversation.generationSnapshot(record.generation);
    if (snapshot.status.kind === "done") {
      const status = projectSubagentGenerationStatus(snapshot.status.outcome);
      if (status !== "cancelled") throw new Error(`Subagent ${subagentId} is ${status} and cannot be cancelled.`);
    } else {
      const wasQueued = snapshot.status.kind === "queued";
      void record.conversation.abort("Generation cancelled.");
      if (wasQueued) this.executionScheduler.cancelQueued(record.generation, record.conversation.generationSnapshot(record.generation));
    }
    await this.finishCancellation(record.conversation, record.generation);
    return { conversationId: record.conversation.conversationId, generation: record.generation.number };
  }

  inspectSubagents(subagentIds: readonly SubagentId[], caller?: SubagentCaller): Array<{ readonly conversationId: ConversationId; readonly snapshot: GenerationSnapshot }> {
    return subagentIds.map(subagentId => {
      const record = this.latestSubagentRecord(subagentId);
      this.assertDescendant(record.conversation, caller, "inspect");
      return { conversationId: record.conversation.conversationId, snapshot: record.conversation.generationSnapshot(record.generation) };
    });
  }
  validateSubagentJoin(subagentId: SubagentId, caller?: SubagentCaller): void { this.assertDirectOwner(this.requireConversation(subagentId), caller, "join"); }

  bindSubagentJoin(subagentIds: readonly SubagentId[], caller?: SubagentCaller, toolCallId?: string): JoinBinding | NestedJoinBinding {
    const records = subagentIds.map(subagentId => this.latestSubagentRecord(subagentId));
    for (const record of records) this.assertDirectOwner(record.conversation, caller, "join");
    return caller ? this.bindNestedJoin(caller, records, toolCallId) : this.withDeferredUpdates(() => this.bindRecords(records));
  }

  private bindNestedJoin(caller: SubagentCaller, records: readonly GenerationRecord[], toolCallId?: string): NestedJoinBinding {
    return this.withDeferredUpdates(() => {
      this.requireCaller(caller, "join");
      const initialTargets = records.map(record => generationRef(record));
      const attemptIndex = caller.conversation.beginNestedJoin(caller.generation, initialTargets, toolCallId);
      try { for (const record of records) this.assertDirectOwner(record.conversation, caller, "join"); }
      catch (error) {
        caller.conversation.updateNestedJoin(caller.generation, attemptIndex, { state: "failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      const base = this.bindRecords(records);
      let terminal = false;
      const targets = (): NestedJoinTargetSnapshot[] => base.project().map(value => ({ conversationId: value.conversationId, generation: value.generation, status: effectiveStatus(value.status) }));
      caller.conversation.updateNestedJoin(caller.generation, attemptIndex, { targets: targets() });
      void base.completion.then(() => {
        if (terminal) return;
        terminal = true;
        this.updateNestedJoin(caller, attemptIndex, { targets: targets(), state: "completed" });
      });
      return {
        owner: callerRef(caller),
        attemptIndex,
        get targets() { return base.targets; },
        completion: base.completion,
        project: () => base.project(),
        markJoined: () => base.markJoined(),
        release: () => base.release(),
        interrupt: (error = "Nested join interrupted.") => {
          if (terminal) return;
          terminal = true;
          this.updateNestedJoin(caller, attemptIndex, { targets: targets(), state: "interrupted", error });
          base.release();
        },
      };
    });
  }

  generationSnapshot(reference: GenerationRef): GenerationSnapshot {
    const { conversation, generation } = this.resolveGeneration(reference);
    return conversation.generationSnapshot(generation);
  }
  generationCaller(reference: GenerationRef): SubagentCaller {
    const { conversation, generation } = this.resolveGeneration(reference);
    return { conversation, generation };
  }
  conversationDisplay(conversationId: ConversationId): ConversationDisplayIdentity {
    const conversation = this.requireConversation(conversationId);
    return { conversationId, label: conversation.label, agentName: conversation.agentName };
  }
  directChildGenerations(owner: GenerationRef): readonly GenerationRef[] {
    const { conversation: ownerConversation } = this.resolveGeneration(owner);
    return [...this.conversations.values()]
      .filter(conversation => conversation.parentConversationId === ownerConversation.conversationId)
      .flatMap(conversation => conversation.generationHistory
        .filter(generation => generation.startedInParentGeneration === owner.generation)
        .map(generation => ({ conversationId: conversation.conversationId, generation: generation.generation })));
  }
  unjoinedDirectChildGenerations(owner: GenerationRef): readonly GenerationRef[] {
    const ownerSnapshot = this.generationSnapshot(owner);
    const mentioned = new Set((ownerSnapshot.nestedJoins ?? []).flatMap(attempt => attempt.targets.map(generationKey)));
    return this.directChildGenerations(owner).filter(child => !mentioned.has(generationKey(child)));
  }

  private bindRecords(records: readonly GenerationRecord[]): JoinBinding {
    const attached: BoundRecord[] = [];
    try { for (const record of records) attached.push({ conversationId: record.conversation.conversationId, binding: record.conversation.bindGeneration(record.generation) }); }
    catch (error) { for (const item of attached) item.binding.release(); throw error; }
    let released = false;
    let resolve!: () => void;
    const completion = new Promise<void>(done => { resolve = done; });
    const check = () => { if (!released && attached.every(item => item.binding.snapshot().status.kind === "done")) resolve(); };
    const unsubscribe = this.onConversationUpdate(check);
    check();
    return {
      targets: Object.freeze(records.map(generationRef)),
      completion,
      project: () => attached.map(item => ({ conversationId: item.conversationId, generation: item.binding.generation.number, status: item.binding.snapshot().status })),
      markJoined: () => { for (const item of attached) if (item.binding.snapshot().status.kind === "done") item.binding.markJoined(); },
      release: () => { if (released) return; released = true; unsubscribe(); for (const item of attached) item.binding.release(); },
    };
  }
  private updateNestedJoin(caller: SubagentCaller, index: number, update: { targets?: readonly NestedJoinTargetSnapshot[]; state?: "running" | "completed" | "failed" | "interrupted"; error?: string }): void {
    if (!this.isCurrentCaller(caller)) return;
    caller.conversation.updateNestedJoin(caller.generation, index, update);
  }

  /** Callers must use the exact latest generation of a retained conversation. */
  private requireCaller(caller: SubagentCaller, action: string): GenerationRecord {
    if (!this.isCurrentCaller(caller)) throw new Error(`${capitalize(action)} caller is no longer active.`);
    return caller;
  }
  private isCurrentCaller(caller: SubagentCaller): boolean {
    return this.conversations.get(caller.conversation.conversationId) === caller.conversation
      && caller.conversation.latestGeneration === caller.generation;
  }
  private assertDirectOwner(target: Conversation, caller: SubagentCaller | undefined, action: string): void {
    if (caller) {
      this.requireCaller(caller, action);
      if (target.parentConversationId !== caller.conversation.conversationId) throw new Error(`Subagent ${target.conversationId} is not directly owned by caller subagent ${caller.conversation.conversationId}.`);
      return;
    }
    if (target.parentConversationId) throw new Error(`Subagent ${target.conversationId} is not directly owned by the root agent.`);
  }
  private assertDescendant(target: Conversation, caller: SubagentCaller | undefined, action: string): void {
    if (!caller) return;
    this.requireCaller(caller, action);
    if (!this.isDescendant(target, caller.conversation.conversationId)) throw new Error(`Subagent ${target.conversationId} is not a descendant of caller subagent ${caller.conversation.conversationId}.`);
  }
  private isDescendant(target: Conversation, ancestorId: ConversationId): boolean {
    const seen = new Set<ConversationId>();
    let parentId = target.parentConversationId;
    while (parentId && !seen.has(parentId)) {
      if (parentId === ancestorId) return true;
      seen.add(parentId);
      parentId = this.conversations.get(parentId)?.parentConversationId;
    }
    return false;
  }
  private latestSubagentRecord(subagentId: SubagentId): GenerationRecord {
    const conversation = this.requireConversation(subagentId);
    return { conversation, generation: conversation.latestGeneration };
  }
  private resolveGeneration(reference: GenerationRef): GenerationRecord {
    const conversation = this.requireConversation(reference.conversationId);
    const generation = conversation.generation(reference.generation);
    if (!generation) throw new Error(`Unknown generation ${reference.generation} in conversation ${reference.conversationId}.`);
    return { conversation, generation };
  }

  async removeConversation(conversationId: string, caller?: SubagentCaller): Promise<RemoveOutcome> { return (await this.removeConversations([conversationId], caller))[0]; }
  async removeConversations(ids: readonly string[], caller?: SubagentCaller): Promise<RemoveOutcome[]> {
    const unique = [...new Set(ids)];
    const failures = new Map<string, Extract<RemoveOutcome, { ok: false }>>();
    const candidates: Conversation[] = [];
    const requestedIds = new Set(unique);
    for (const id of unique) {
      const conversation = this.conversations.get(id as ConversationId);
      if (!conversation) { failures.set(id, { ok: false, conversationId: id, error: new SubagentNotFoundError(id).message }); continue; }
      try { this.assertDirectOwner(conversation, caller, "remove"); candidates.push(conversation); }
      catch (error) {
        let ancestorId = conversation.parentConversationId;
        let covered = false;
        while (ancestorId) {
          if (requestedIds.has(ancestorId)) {
            try { this.assertDirectOwner(this.conversations.get(ancestorId)!, caller, "remove"); covered = true; break; } catch {}
          }
          ancestorId = this.conversations.get(ancestorId)?.parentConversationId;
        }
        if (covered) candidates.push(conversation);
        else failures.set(id, { ok: false, conversationId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const subtrees = new Map(candidates.map(conversation => [conversation.conversationId, this.conversationSubtree(conversation.conversationId)]));
    const requested = new Set(candidates.map(conversation => conversation.conversationId));
    const roots = candidates.filter(conversation => {
      let parentId = conversation.parentConversationId;
      while (parentId) { if (requested.has(parentId)) return false; parentId = this.conversations.get(parentId)?.parentConversationId; }
      return true;
    });
    const removed = new Set<ConversationId>();
    const removedConversations: Conversation[] = [];
    for (const root of roots) {
      const subtree = subtrees.get(root.conversationId)!;
      const active = subtree.filter(conversation => conversation.hasActiveExecution);
      if (active.length) {
        const error = `Subagent subtree ${root.conversationId} has active subagents: ${active.map(conversation => conversation.conversationId).join(", ")}. Cancel them before removal.`;
        for (const target of candidates) if (subtree.includes(target)) failures.set(target.conversationId, { ok: false, conversationId: target.conversationId, error });
        continue;
      }
      for (const conversation of [...subtree].reverse()) {
        this.conversations.delete(conversation.conversationId);
        removed.add(conversation.conversationId);
        removedConversations.push(conversation);
      }
    }
    for (const conversation of removedConversations) for (const listener of [...this.listeners]) try { listener(conversation, "removed"); } catch {}
    const claimed = new Set<ConversationId>();
    const attributed = new Map<ConversationId, ConversationId[]>();
    for (const conversation of [...candidates].sort((a, b) => subtrees.get(b.conversationId)!.length - subtrees.get(a.conversationId)!.length)) {
      const removedIds = subtrees.get(conversation.conversationId)!.map(item => item.conversationId).filter(id => removed.has(id) && !claimed.has(id)).reverse();
      for (const id of removedIds) claimed.add(id);
      attributed.set(conversation.conversationId, removedIds);
    }
    return unique.map(id => {
      const failure = failures.get(id);
      if (failure) return failure;
      const conversation = candidates.find(item => item.conversationId === id)!;
      if (!removed.has(conversation.conversationId)) return { ok: false as const, conversationId: id, error: `Subagent ${id} was not removed.` };
      return { ok: true as const, conversationId: conversation.conversationId, label: conversation.label, removedIds: attributed.get(conversation.conversationId)! };
    });
  }

  private conversationSubtree(rootId: ConversationId): Conversation[] {
    const result: Conversation[] = [];
    const visit = (conversation: Conversation) => {
      result.push(conversation);
      for (const child of this.conversations.values()) if (child.parentConversationId === conversation.conversationId) visit(child);
    };
    visit(this.requireConversation(rootId));
    return result;
  }
  private requireConversation(id: string): Conversation {
    const found = this.conversations.get(id as ConversationId);
    if (!found) throw new SubagentNotFoundError(id);
    return found;
  }
  private async finishCancellation(conversation: Conversation, generation: Generation): Promise<void> {
    const settled = await this.waitForCancellationSettlement(conversation);
    if (!settled && conversation.isStopping) {
      this.executionScheduler.abandon(generation, conversation.forceAbandonCancellation(generation));
    }
  }
  private waitForCancellationSettlement(conversation: Conversation): Promise<boolean> {
    if (!conversation.isStopping) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const finish = (settled: boolean) => { if (done) return; done = true; clearTimeout(timer); unsubscribe(); resolve(settled); };
      const unsubscribe = this.onConversationUpdate(updated => { if (updated === conversation && !conversation.isStopping) finish(true); });
      const timer = setTimeout(() => finish(false), this.cancellationSettlementMs);
      if (!conversation.isStopping) finish(true);
    });
  }
  private resumeError(conversation: Conversation): string {
    return conversation.isStopping
      ? `Subagent ${conversation.conversationId} is still settling a cancelled execution. Wait for it to finish before resuming.`
      : `Subagent ${conversation.conversationId} cannot be resumed.`;
  }
  private capacityError(): string {
    const removable = [...this.conversations.values()].filter(conversation => !conversation.hasActiveExecution).map(conversation => conversation.conversationId);
    return `Subagent capacity (${this.maxConversations}) reached. Remove inactive subagents${removable.length ? `: ${removable.join(", ")}` : " before spawning more"}.`;
  }
  private withDeferredUpdates<T>(operation: () => T): T {
    this.updateDeferralDepth++;
    try { return operation(); }
    finally {
      this.updateDeferralDepth--;
      if (this.updateDeferralDepth === 0) {
        const pending = [...this.deferredUpdates].flatMap(([conversation, kinds]) => [...kinds].map(kind => ({ conversation, kind })));
        this.deferredUpdates.clear();
        for (const { conversation, kind } of pending) this.updated(conversation, kind);
      }
    }
  }
  private updated(conversation: Conversation, kind: ConversationUpdateKind): void {
    if (this.conversations.get(conversation.conversationId) !== conversation) return;
    if (this.updateDeferralDepth > 0) {
      const kinds = this.deferredUpdates.get(conversation) ?? new Set<ConversationUpdateKind>();
      kinds.add(kind);
      this.deferredUpdates.set(conversation, kinds);
      return;
    }
    for (const listener of this.listeners) listener(conversation, kind);
  }
}

function generationRef(record: GenerationRecord): GenerationRef { return { conversationId: record.conversation.conversationId, generation: record.generation.number }; }
function callerRef(caller: SubagentCaller): GenerationRef { return { conversationId: caller.conversation.conversationId, generation: caller.generation.number }; }
function capitalize(value: string): string { return value[0].toUpperCase() + value.slice(1); }
