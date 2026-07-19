import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { Agent } from "../domain/agent.js";
import type { Attempt } from "../domain/agent-attempt.js";
import { errorRun, interruptedRun, skippedRun } from "../domain/agent-finalize.js";
import type { AgentRunSnapshot } from "../domain/agent-snapshot.js";
import { DefaultRunAgentDependencies, RunAttempt } from "./run-agent.js";
import { TaskQueue, type QueueLease } from "./task-queue.js";
import { timingStart } from "./timing.js";

export type AgentRunner = (
  ctx: ExtensionContext,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
) => Promise<AgentRunSnapshot>;

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
  private _childTool?: (agent: Agent) => ToolDefinition;

  constructor(opts: AttemptRunnerOptions) {
    this._queue = new TaskQueue(opts.maxRunning);
    this._isTracked = opts.isTracked ?? (() => true);
    this._runner = opts.runner ?? ((ctx, agent, attempt, signal) =>
      RunAttempt(ctx, agent, attempt, signal, {
        ...DefaultRunAgentDependencies,
        ...(this._childTool ? { childToolFor: this._childTool } : {}),
      }));
  }

  setChildTool(fn: (agent: Agent) => ToolDefinition): void {
    this._childTool = fn;
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
    agent: Agent,
    attempt: Attempt,
  ): Promise<AgentRunSnapshot> {
    const kind = attempt.kind;
    return this._queue.enqueue(async lease => {
      const end = timingStart(`manager.${kind}Task`, { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parent?.conversationId });
      let result: AgentRunSnapshot;
      let error: string | undefined;

      if (signal?.aborted || !this._isTracked(agent.conversationId)) {
        result = skippedRun(agent, attempt.runId);
      } else if (agent.status.kind === "done" && !agent.hasCurrentAttempt) {
        result = agent.runHistory.find(run => run.runId === attempt.runId)!;
      } else {
        this._leases.set(agent.conversationId, lease);
        try {
          result = await this._runner(ctx, agent, attempt, signal);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (agent.status.kind === "done" && !agent.hasCurrentAttempt) {
            result = agent.runHistory.find(run => run.runId === attempt.runId)!;
          } else {
            error = message;
            if (signal?.aborted) {
              if (attempt.state.kind === "queued") skippedRun(agent, attempt.runId);
              else interruptedRun(agent, attempt.runId, message);
            } else errorRun(agent, attempt.runId, message);
            result = agent.runHistory.find(run => run.runId === attempt.runId)!;
          }
        } finally {
          this._leases.delete(agent.conversationId);
        }
      }

      const status = result.status;
      end({ status: status.kind === "done" ? status.outcome : status.kind, error });
      return result;
    }, { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parent?.conversationId, kind });
  }
}
