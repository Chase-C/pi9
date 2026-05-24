import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { Agent } from "../domain/agent.js";
import type { Attempt } from "../domain/agent-attempt.js";
import { errorRun, interruptedRun, skippedRun } from "../domain/agent-finalize.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { DefaultRunAgentDependencies, RunAttempt } from "./run-agent.js";
import { TaskQueue, type QueueLease } from "./task-queue.js";
import { timingMark, timingStart } from "./timing.js";

export type AgentRunner = (
  ctx: ExtensionContext,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
) => Promise<AgentSnapshot>;

export interface AttemptRunnerOptions {
  maxRunning: number;
  /** Override the default RunAttempt invocation. Used by tests to inject a fake runner. */
  runner?: AgentRunner;
  /** Returns false once the agent has been removed from its catalog, signalling the queued
   *  attempt should be skipped rather than dispatched. Defaults to always-true. */
  isTracked?: (agentId: string) => boolean;
}

export class AttemptRunner {

  private readonly _queue: TaskQueue;
  private readonly _leases = new Map<string, QueueLease>();
  private readonly _runner: AgentRunner;
  private _isTracked: (agentId: string) => boolean;
  private _childFactory?: (agent: Agent) => ExtensionFactory;

  constructor(opts: AttemptRunnerOptions) {
    this._queue = new TaskQueue(opts.maxRunning);
    this._isTracked = opts.isTracked ?? (() => true);
    this._runner = opts.runner ?? ((ctx, agent, attempt, signal) =>
      RunAttempt(ctx, agent, attempt, signal, {
        ...DefaultRunAgentDependencies,
        ...(this._childFactory ? { childFactoryFor: this._childFactory } : {}),
      }));
  }

  setChildFactory(fn: (agent: Agent) => ExtensionFactory): void {
    this._childFactory = fn;
  }

  setIsTracked(fn: (agentId: string) => boolean): void {
    this._isTracked = fn;
  }

  configure(opts: { maxRunning?: number }): void {
    if (opts.maxRunning !== undefined) this._queue.maxRunning = opts.maxRunning;
  }

  /**
   * Releases the named agent's queue slot while `fn` runs, then re-acquires it before returning.
   * Used by the child subagent tool so a parent awaiting `batch.resultsPromise` doesn't pin the
   * only queue slot a recursive descendant needs to start — without this, a tree deeper than
   * maxRunning deadlocks. No-op when the session has no active lease.
   */
  async suspendAgentSlotDuring<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const lease = this._leases.get(sessionId);
    if (!lease) {
      timingMark("manager.suspendAgentSlot.skip", { sessionId, reason: "no-active-lease" });
      return fn();
    }
    const end = timingStart("manager.suspendAgentSlot", { sessionId });
    try {
      return await lease.suspendDuring(fn);
    } finally {
      end({});
    }
  }

  run(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    agent: Agent,
    attempt: Attempt,
  ): Promise<AgentSnapshot> {
    const kind = attempt.kind;
    const resumed = kind === "resume";
    return this._queue.enqueue(async lease => {
      const end = timingStart(`manager.${kind}Task`, { agent: agent.agentName, sessionId: agent.id, parentSessionId: agent.parentId });
      let result: AgentSnapshot;
      let error: string | undefined;

      if (signal?.aborted || !this._isTracked(agent.id)) {
        result = skippedRun(agent, resumed);
      } else if (agent.status.kind === "done" && !agent.hasCurrentAttempt) {
        result = agent.snapshot();
      } else {
        this._leases.set(agent.id, lease);
        try {
          result = await this._runner(ctx, agent, attempt, signal);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (agent.status.kind === "done" && !agent.hasCurrentAttempt) {
            result = agent.snapshot();
          } else {
            error = message;
            result = signal?.aborted
              ? (attempt.state.kind === "queued" ? skippedRun(agent, resumed) : interruptedRun(agent, message, resumed))
              : errorRun(agent, message, resumed);
          }
        } finally {
          this._leases.delete(agent.id);
        }
      }

      end({ status: result.status.kind === "done" ? result.status.outcome : result.status.kind, error });
      return result;
    }, { agent: agent.agentName, sessionId: agent.id, parentSessionId: agent.parentId, kind });
  }
}
