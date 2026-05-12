import { randomUUID } from "node:crypto";

import { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import { InvocationFromTask } from "../domain/agent-invocation.js";
import {
  errorRun,
  finalizeRun,
  interruptedRun,
  skippedRun,
  type AgentRunResult,
  type FinalizeRunArgs,
} from "../domain/agent-result.js";
import type { AgentUpdateKind, AgentView, SubagentBatchUpdate } from "../domain/agent-view.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import { preflightResumeFailure, preflightSpawnFailure } from "../domain/preflight-failure.js";
import type { ResumeRequest, TaskRequest } from "../schema.js";
import { activeOrRetainedAgents } from "../view/view-helpers.js";
import { ResumeAgent, RunAgent } from "./run-agent.js";
import { TaskQueue } from "./task-queue.js";
import { timingMark, timingStart, timingSync } from "./timing.js";

const MESSAGE_UPDATE_THROTTLE_MS = 100;
const ANIMATION_UPDATE_INTERVAL_MS = 120;

export type AgentManagerUpdateListener = (update: SubagentBatchUpdate) => void;
export type AgentRunner = (ctx: ExtensionContext, agent: Agent, prompt: string, signal?: AbortSignal) => Promise<AgentRunResult>;
export type AgentResumeRunner = (ctx: ExtensionContext, agent: Agent, prompt: string, signal?: AbortSignal) => Promise<AgentRunResult>;

interface BatchEntry {
  agent?: Agent;
  view?: AgentView;
  inputIndex: number;
  resumed?: boolean;
}

interface SpawnBatch {
  groupId: string;
  entries: BatchEntry[];
  listener?: AgentManagerUpdateListener;
  pendingMessageTimer?: NodeJS.Timeout;
  animationTimer?: NodeJS.Timeout;
}

export class AgentManager {

  private _agents = new Array<Agent>();
  private _queue: TaskQueue;
  private _activeBatches = new Map<string, SpawnBatch>();
  private _agentBatch = new Map<string, string>();
  private _reservedResumeSessionIds = new Set<string>();

  constructor(
    readonly registry: AgentRegistry,
    maxRunning: number = 4,
    private readonly _runAgent: AgentRunner = RunAgent,
    private readonly _resumeAgent: AgentResumeRunner = ResumeAgent,
  ) {
    this._queue = new TaskQueue(maxRunning);
  }

  get sessions(): AgentView[] {
    return activeOrRetainedAgents(this._agents).map(agent => agent.toView());
  }

  configure(options: { maxRunning?: number }) {
    if (options.maxRunning !== undefined) this._queue.maxRunning = options.maxRunning;
  }

  clear(
    sessionId?: string,
  ): { cleared: number; sessionId?: string } {
    if (sessionId) {
      const agent = this._agents.find(a => a.id === sessionId);
      if (!agent) {
        return { cleared: 0, sessionId };
      }

      const groupId = this._agentBatch.get(agent.id);
      this._agents = this._agents.filter(a => a.id !== sessionId);
      this._agentBatch.delete(agent.id);
      if (agent.status.kind === "running") {
        finalizeRun(agent, "", { status: "aborted", error: "Agent aborted." });
      } else if (groupId) {
        this._emitBatchUpdate(groupId);
      }

      return { cleared: 1, sessionId };
    }

    const keep = (agent: Agent) => agent.status.kind === "queued" || agent.status.kind === "running";
    const toClear = this._agents.filter(a => !keep(a));
    this._agents = this._agents.filter(a => keep(a));

    toClear.forEach(agent => this._agentBatch.delete(agent.id));
    this._agents.forEach(agent => {
      const groupId = this._agentBatch.get(agent.id);
      if (groupId) this._emitBatchUpdate(groupId);
    });

    return { cleared: toClear.length };
  }

  async run(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    tasks: TaskRequest[],
    onUpdate?: AgentManagerUpdateListener,
  ): Promise<AgentRunResult[]> {
    const groupId = randomUUID();
    const groupCreatedAt = Date.now();
    timingMark("manager.run.start", { groupId, taskCount: tasks.length });

    const entries: BatchEntry[] = [];
    const batch: SpawnBatch = { groupId, entries, listener: onUpdate };
    this._activeBatches.set(groupId, batch);

    const touched = new Set<Agent>();

    const resultPromises = tasks.map((task, inputIndex) => {
      if (task.kind === "spawn") {
        const config = this.registry.agents.get(task.agent);
        if (!config) {
          const available = Array
            .from(this.registry.agents.values())
            .map((agent) => `${agent.name} (${agent.source})`)
            .join("\n");
          const error = `Unknown agent: ${task.agent}. Available agents:\n${available}`;
          const { view, result } = preflightSpawnFailure({
            groupId, inputIndex, createdAt: groupCreatedAt, task, error,
          });
          entries.push({ view, inputIndex });
          timingMark("manager.task.preflightFailure", { groupId, inputIndex, agent: task.agent });
          return Promise.resolve(result);
        }

        const { spawn, invocation } = InvocationFromTask(task);
        const agent = new Agent(randomUUID(), config, spawn, invocation, this._agentUpdate.bind(this));
        entries.push({ agent, inputIndex });
        timingMark("manager.task.spawnCreated", { groupId, inputIndex, agent: task.agent, sessionId: agent.id });
        this._agents.push(agent);
        this._agentBatch.set(agent.id, groupId);
        touched.add(agent);
        return this._runSpawn(ctx, signal, agent, task.prompt);
      }
      // task.kind === "resume"
      else {
        const target = this._agents.find(a => a.id === task.sessionId && a.resumable);
        const isValidStatus = target && (
          (target.status.kind === "done" && target.status.result.status === "completed") ||
          target.status.kind === "resumeFailed"
        );
        const isReserved = target && this._reservedResumeSessionIds.has(target.id);
        if (!target || !isValidStatus || isReserved) {
          let error: string;
          if (!target) {
            error = `Unknown resumable subagent session: ${task.sessionId}`;
          } else if (isReserved) {
            error = `Cannot resume subagent session ${task.sessionId} while it is already being resumed.`;
          } else {
            const detail = target.status.kind === "done" ? target.status.result.status : target.status.kind;
            error = `Cannot resume subagent session ${task.sessionId} while it is ${detail}.`;
          }
          const { view, result } = preflightResumeFailure({
            groupId, inputIndex, createdAt: groupCreatedAt, task, target, error,
          });
          entries.push({ view, inputIndex, resumed: true });
          timingMark("manager.task.resumePreflightFailure", { groupId, inputIndex, sessionId: task.sessionId });
          return Promise.resolve(result);
        }

        entries.push({ agent: target, inputIndex, resumed: true });
        timingMark("manager.task.resumeCreated", { groupId, inputIndex, sessionId: target.id });
        this._agentBatch.set(target.id, groupId);
        touched.add(target);
        return this._runResume(ctx, signal, target, task);
      }
    });

    timingMark("manager.initialEmit.before", { groupId, entries: entries.length });
    this._emitBatchUpdate(groupId);
    timingMark("manager.initialEmit.after", { groupId });
    try {
      const results = await Promise.all(resultPromises);
      this._agents = this._agents.filter(agent => {
        if (!touched.has(agent)) return true;
        if (agent.status.kind !== "done") return true;
        if (agent.resumable) return true;
        this._agentBatch.delete(agent.id);
        return false;
      });
      timingMark("manager.run.results", { groupId, resultCount: results.length });
      return results;
    } finally {
      this._flushPendingMessageUpdate(batch);
      this._clearAnimationUpdate(batch);
      this._activeBatches.delete(groupId);
    }
  }

  private _agentUpdate(agent: Agent, kind: AgentUpdateKind) {
    const groupId = this._agentBatch.get(agent.id);
    if (!groupId) return;
    const batch = this._activeBatches.get(groupId);
    if (!batch) return;
    if (kind === "message") {
      this._clearAnimationUpdate(batch);
      if (!batch.pendingMessageTimer) {
        batch.pendingMessageTimer = setTimeout(() => {
          batch.pendingMessageTimer = undefined;
          this._emitBatchUpdate(batch.groupId);
        }, MESSAGE_UPDATE_THROTTLE_MS);
      }

      return;
    }
    this._clearPendingMessageUpdate(batch);
    this._emitBatchUpdate(groupId);
  }

  private _runSpawn(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    agent: Agent,
    prompt: string,
  ): Promise<AgentRunResult> {
    return this._queue.enqueue(async () => {
      const end = timingStart("manager.spawnTask", { agent: agent.agentName, sessionId: agent.id });
      if (signal?.aborted) {
        const result = skippedRun(agent, prompt);
        end({ status: result.status });
        return result;
      }
      try {
        const result = await this._runAgent(ctx, agent, prompt, signal);
        end({ status: result.status });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (agent.status.kind === "done") {
          end({ status: agent.status.result.status });
          return agent.status.result;
        }
        if (signal?.aborted) {
          const result = agent.status.kind === "queued"
            ? skippedRun(agent, prompt)
            : interruptedRun(agent, prompt, message);
          end({ status: result.status, error: message });
          return result;
        }
        const result = errorRun(agent, prompt, message);
        end({ status: result.status, error: message });
        return result;
      }
    }, { agent: agent.agentName, sessionId: agent.id, kind: "spawn" });
  }

  private async _runResume(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    target: Agent,
    task: ResumeRequest,
  ): Promise<AgentRunResult> {
    this._reservedResumeSessionIds.add(target.id);
    const { prompt } = task;
    const { invocation } = InvocationFromTask(task);
    const undo = target.apply(invocation);
    const originalStatus = target.status;

    const closePreAttach = (args: FinalizeRunArgs): AgentRunResult => {
      undo();
      const result = target.buildResult(prompt, { ...args, resumed: true });
      target.markResumeFailed(result);
      return result;
    };

    try {
      return await this._queue.enqueue(async () => {
        const end = timingStart("manager.resumeTask", { agent: target.agentName, sessionId: target.id });
        if (signal?.aborted) {
          const result = closePreAttach({ status: "skipped", error: "Agent skipped." });
          end({ status: result.status });
          return result;
        }
        try {
          const result = await this._resumeAgent(ctx, target, prompt, signal);
          const resumed = result.resumed ? result : { ...result, resumed: true };
          end({ status: resumed.status });
          return resumed;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (target.status === originalStatus) {
            const result = closePreAttach({ status: "error", error: message });
            end({ status: result.status, error: message });
            return result;
          }
          if (target.status.kind === "done") {
            end({ status: target.status.result.status });
            return target.status.result;
          }
          if (signal?.aborted) {
            const result = interruptedRun(target, prompt, message, true);
            end({ status: result.status, error: message });
            return result;
          }
          const result = errorRun(target, prompt, message, true);
          end({ status: result.status, error: message });
          return result;
        }
      }, { agent: target.agentName, sessionId: target.id, kind: "resume" });
    } finally {
      this._reservedResumeSessionIds.delete(target.id);
    }
  }

  private _flushPendingMessageUpdate(batch: SpawnBatch) {
    if (!this._clearPendingMessageUpdate(batch)) return;
    this._emitBatchUpdate(batch.groupId);
  }

  private _clearPendingMessageUpdate(batch: SpawnBatch): boolean {
    if (!batch.pendingMessageTimer) return false;
    clearTimeout(batch.pendingMessageTimer);
    batch.pendingMessageTimer = undefined;
    return true;
  }

  private _emitBatchUpdate(groupId: string) {
    const batch = this._activeBatches.get(groupId);
    if (!batch?.listener) return;

    const end = timingStart("manager.emitBatchUpdate", { groupId, entries: batch.entries.length });
    const sessions = batch.entries
      .slice()
      .sort((a, b) => a.inputIndex - b.inputIndex)
      .map(({ agent, view, inputIndex, resumed }) => {
        const baseView = view ?? (agent ? agent.toView(inputIndex) : view!);
        return { ...baseView, resumed: Boolean(resumed) };
      });
    const active = sessions.some(s => s.status.kind === "queued" || s.status.kind === "running");
    timingSync("manager.listener", { groupId, sessionCount: sessions.length, active }, () => batch.listener?.({ sessions, active }));
    this._scheduleAnimationUpdate(batch, active);
    end({ active, sessionCount: sessions.length });
  }

  private _scheduleAnimationUpdate(batch: SpawnBatch, active: boolean) {
    if (!active) {
      this._clearAnimationUpdate(batch);
      return;
    }
    if (batch.animationTimer) return;
    batch.animationTimer = setTimeout(() => {
      batch.animationTimer = undefined;
      this._emitBatchUpdate(batch.groupId);
    }, ANIMATION_UPDATE_INTERVAL_MS);
    batch.animationTimer.unref?.();
  }

  private _clearAnimationUpdate(batch: SpawnBatch) {
    if (!batch.animationTimer) return;
    clearTimeout(batch.animationTimer);
    batch.animationTimer = undefined;
  }
}
