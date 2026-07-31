import type { AgentSessionEvent, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Conversation, effectiveStatus, errorGeneration, interruptedGeneration, skippedGeneration, type Generation, type GenerationSnapshot } from "./conversation.js";
import { DEFAULT_EXECUTE_GENERATION_DEPENDENCIES, executeGeneration } from "./execute.js";
import { timingStart } from "./timing.js";

/** Lets an executing task yield its capacity while awaiting queued descendant work. */
export interface ExecutionQueueLease { suspendDuring<T>(fn: () => Promise<T>): Promise<T> }
export interface ExecutionQueueTask<T> { readonly completion: Promise<T>; cancel(result: T): boolean; abandon(result: T): boolean }

export class ExecutionQueue {
  private readonly pending: Array<() => void> = [];
  private executing = 0;

  constructor(public maxExecuting: number) {}

  enqueue<T>(task: (lease: ExecutionQueueLease) => Promise<T>, timingData: Record<string, unknown> = {}): Promise<T> {
    return this.enqueueCancellable(task, timingData).completion;
  }

  enqueueCancellable<T>(task: (lease: ExecutionQueueLease) => Promise<T>, timingData: Record<string, unknown> = {}): ExecutionQueueTask<T> {
    let resolveTask!: (value: T) => void;
    let rejectTask!: (reason?: unknown) => void;
    let pending = true;
    let abandoned = false;
    let occupyingSlot = false;
    const completion = new Promise<T>((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
    const queuedAt = Date.now();
    const start = () => {
      pending = false;
      this.executing++;
      occupyingSlot = true;
      const lease: ExecutionQueueLease = {
        suspendDuring: async <R>(fn: () => Promise<R>): Promise<R> => {
          if (!occupyingSlot || abandoned) return fn();
          occupyingSlot = false;
          this.executing--;
          this.flush();
          try { return await fn(); }
          finally {
            if (!abandoned) {
              await this.acquire();
              if (abandoned) { this.executing--; this.flush(); }
              else occupyingSlot = true;
            }
          }
        },
      };
      const waitMs = Date.now() - queuedAt;
      setImmediate(() => {
        const end = timingStart("queue.task", { ...timingData, waitMs });
        task(lease).then(resolveTask, rejectTask).finally(() => {
          if (occupyingSlot) { occupyingSlot = false; this.executing--; }
          end({ executing: this.executing, pending: this.pending.length });
          this.flush();
        });
      });
    };
    this.pending.push(start);
    this.flush();
    const cancel = (result: T): boolean => {
      if (!pending) return false;
      const index = this.pending.indexOf(start);
      if (index < 0) return false;
      this.pending.splice(index, 1);
      pending = false;
      resolveTask(result);
      return true;
    };
    return {
      completion,
      cancel,
      abandon: result => {
        if (cancel(result)) return true;
        if (abandoned) return false;
        abandoned = true;
        if (occupyingSlot) { occupyingSlot = false; this.executing--; this.flush(); }
        resolveTask(result);
        return true;
      },
    };
  }

  private acquire(): Promise<void> {
    return new Promise(resolve => {
      this.pending.push(() => { this.executing++; resolve(); });
      this.flush();
    });
  }
  private flush(): void { while (this.executing < this.maxExecuting && this.pending.length) this.pending.shift()!(); }
}

export type GenerationExecutor = (ctx: ExtensionContext, conversation: Conversation, generation: Generation, signal?: AbortSignal) => Promise<GenerationSnapshot>;
export interface GenerationSchedulerOptions {
  maxExecuting: number;
  executor?: GenerationExecutor;
  isTracked?: (conversation: Conversation) => boolean;
}

export class GenerationScheduler {
  private readonly queue: ExecutionQueue;
  private readonly leases = new Map<Conversation, ExecutionQueueLease>();
  private readonly executor: GenerationExecutor;
  private readonly queued = new Map<Generation, ExecutionQueueTask<GenerationSnapshot>>();
  private isTracked: (conversation: Conversation) => boolean;
  private childTool?: (conversation: Conversation) => ToolDefinition;
  private childSessionEvent?: (conversation: Conversation, generation: Generation, event: AgentSessionEvent) => void;

  constructor(options: GenerationSchedulerOptions) {
    this.queue = new ExecutionQueue(options.maxExecuting);
    this.isTracked = options.isTracked ?? (() => true);
    this.executor = options.executor ?? ((ctx, conversation, generation, signal) => executeGeneration(ctx, conversation, generation, signal, {
      ...DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
      ...(this.childTool ? { childToolFor: this.childTool } : {}),
      ...(this.childSessionEvent ? { childSessionEvent: this.childSessionEvent } : {}),
    }));
  }

  setChildTool(fn: (conversation: Conversation) => ToolDefinition): void { this.childTool = fn; }
  setChildSessionEvent(fn: (conversation: Conversation, generation: Generation, event: AgentSessionEvent) => void): void { this.childSessionEvent = fn; }
  configure(options: { maxExecuting?: number }): void {
    if (options.maxExecuting !== undefined) this.queue.maxExecuting = options.maxExecuting;
  }

  async suspendConversationSlotDuring<T>(conversation: Conversation, fn: () => Promise<T>): Promise<T> {
    const lease = this.leases.get(conversation);
    if (!lease) return fn();
    const end = timingStart("manager.suspendConversationSlot", { conversationId: conversation.conversationId });
    try { return await lease.suspendDuring(fn); }
    finally { end({}); }
  }

  schedule(ctx: ExtensionContext, signal: AbortSignal | undefined, conversation: Conversation, generation: Generation): Promise<GenerationSnapshot> {
    const kind = generation.kind;
    const snapshot = () => conversation.generationSnapshot(generation);
    const scheduled = this.queue.enqueueCancellable(async lease => {
      const end = timingStart(`manager.${kind}Task`, { agent: conversation.agentName, conversationId: conversation.conversationId, parentConversationId: conversation.parentConversationId });
      let result: GenerationSnapshot;
      let error: string | undefined;
      if (generation.state.kind === "done") result = snapshot();
      else if (signal?.aborted || !this.isTracked(conversation)) result = skippedGeneration(conversation, generation);
      else if (generation !== conversation.latestGeneration || !conversation.hasCurrentGeneration) result = snapshot();
      else {
        this.leases.set(conversation, lease);
        try { result = await this.executor(ctx, conversation, generation, signal); }
        catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          const currentSnapshot = snapshot();
          if (currentSnapshot.status.kind === "done" || generation !== conversation.latestGeneration) result = currentSnapshot;
          else {
            error = message;
            if (signal?.aborted) {
              if (currentSnapshot.status.kind === "queued") skippedGeneration(conversation, generation);
              else interruptedGeneration(conversation, generation, message);
            } else errorGeneration(conversation, generation, message);
            result = snapshot();
          }
        } finally { if (this.leases.get(conversation) === lease) this.leases.delete(conversation); }
      }
      end({ status: effectiveStatus(result.status), error });
      return result;
    }, { agent: conversation.agentName, conversationId: conversation.conversationId, parentConversationId: conversation.parentConversationId, kind });
    this.queued.set(generation, scheduled);
    const cleanup = () => { if (this.queued.get(generation) === scheduled) this.queued.delete(generation); };
    void scheduled.completion.then(cleanup, cleanup);
    return scheduled.completion;
  }

  cancelQueued(generation: Generation, result: GenerationSnapshot): boolean { return this.queued.get(generation)?.cancel(result) ?? false; }
  abandon(generation: Generation, result: GenerationSnapshot): boolean { return this.queued.get(generation)?.abandon(result) ?? false; }
}
