import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { Agent } from "../domain/agent.js";
import type { Attempt } from "../domain/agent-attempt.js";
import { errorRun, interruptedRun, skippedRun } from "../domain/agent-finalize.js";
import type { AgentRunResult } from "../domain/agent-result.js";
import { DefaultRunAgentDependencies, RunAttempt } from "./run-agent.js";
import { TaskQueue, type QueueLease } from "./task-queue.js";
import { timingMark, timingStart } from "./timing.js";

export type AgentRunner = (
  ctx: ExtensionContext,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
) => Promise<AgentRunResult>;

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
  ): Promise<AgentRunResult> {
    const kind = attempt.kind;
    const resumed = kind === "resume";
    return this._queue.enqueue(async lease => {
      const end = timingStart(`manager.${kind}Task`, { agent: agent.agentName, sessionId: agent.id, parentSessionId: agent.parentSessionId });
      if (signal?.aborted || !this._isTracked(agent.id)) {
        const result = skippedRun(agent, resumed);
        end({ status: result.status });
        return result;
      }
      if (agent.status.kind === "done" && !agent.hasCurrentAttempt) {
        end({ status: agent.status.result.status });
        return agent.status.result;
      }
      this._leases.set(agent.id, lease);
      try {
        const result = await this._runner(ctx, agent, attempt, signal);
        const finalResult = resumed && !result.resumed ? { ...result, resumed: true } : result;
        end({ status: finalResult.status });
        return finalResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (agent.status.kind === "done" && !agent.hasCurrentAttempt) {
          end({ status: agent.status.result.status });
          return agent.status.result;
        }
        const result = signal?.aborted
          ? (attempt.state.kind === "queued" ? skippedRun(agent, resumed) : interruptedRun(agent, message, resumed))
          : errorRun(agent, message, resumed);
        end({ status: result.status, error: message });
        return result;
      } finally {
        this._leases.delete(agent.id);
      }
    }, { agent: agent.agentName, sessionId: agent.id, parentSessionId: agent.parentSessionId, kind });
  }
}
