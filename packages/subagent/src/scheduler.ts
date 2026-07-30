import type { AgentSessionEvent, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Conversation, effectiveStatus, errorRun, interruptedRun, skippedRun, type Run, type RunSnapshot } from "./conversation.js";
import { DEFAULT_EXECUTE_RUN_DEPENDENCIES, executeRun } from "./execute.js";
import type { RunId } from "./identifiers.js";
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
  abandon(result: T): boolean;
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
    let abandoned = false;
    let occupyingSlot = false;
    const completion = new Promise<T>((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
    const queuedAt = Date.now();
    const start = () => {
      pending = false;
      this._running++;
      occupyingSlot = true;
      const lease: RunQueueLease = {
        suspendDuring: async <R>(fn: () => Promise<R>): Promise<R> => {
          if (!occupyingSlot || abandoned) return fn();
          occupyingSlot = false;
          this._running--;
          this._flush();
          try {
            return await fn();
          } finally {
            if (!abandoned) {
              await this._acquire();
              occupyingSlot = true;
            }
          }
        },
      };
      const waitMs = Date.now() - queuedAt;
      setImmediate(() => {
        const end = timingStart("queue.task", { ...timingData, waitMs });
        task(lease)
          .then(resolveTask, rejectTask)
          .finally(() => {
            if (occupyingSlot) {
              occupyingSlot = false;
              this._running--;
            }
            end({ running: this._running, pending: this._pending.length });
            this._flush();
          });
      });
    };
    this._pending.push(start);
    this._flush();
    const cancel = (result: T): boolean => {
      if (!pending) return false;
      const index = this._pending.indexOf(start);
      if (index < 0) return false;
      this._pending.splice(index, 1);
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
        if (occupyingSlot) {
          occupyingSlot = false;
          this._running--;
          this._flush();
        }
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
    const historySnapshot = () => agent.runHistory.find(item => item.runId === run.runId)!;
    const scheduled = this._queue.enqueueCancellable(async lease => {
      const end = timingStart(`manager.${kind}Task`, { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parentConversationId });
      let result: RunSnapshot;
      let error: string | undefined;

      if (run.state.kind === "done") {
        result = historySnapshot();
      } else if (signal?.aborted || !this._isTracked(agent.conversationId)) {
        result = skippedRun(agent, run.runId);
      } else if (!agent.hasCurrentRun) {
        result = historySnapshot();
      } else {
        this._leases.set(agent.conversationId, lease);
        try {
          result = await this._executor(ctx, agent, run, signal);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (!agent.hasCurrentRun) {
            result = historySnapshot();
          } else {
            error = message;
            if (signal?.aborted) {
              if (run.state.kind === "queued") skippedRun(agent, run.runId);
              else interruptedRun(agent, run.runId, message);
            } else errorRun(agent, run.runId, message);
            result = historySnapshot();
          }
        } finally {
          this._leases.delete(agent.conversationId);
        }
      }

      const status = result.status;
      end({ status: effectiveStatus(status), error });
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

  abandon(runId: RunId, result: RunSnapshot): boolean {
    return this._queued.get(runId)?.abandon(result) ?? false;
  }
}
