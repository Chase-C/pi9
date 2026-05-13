import { randomUUID } from "node:crypto";

import { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import { InvocationFromTask } from "../domain/agent-invocation.js";
import {
  errorRun,
  interruptedRun,
  skippedRun,
  type AgentRunResult,
  type FinalizeRunArgs,
} from "../domain/agent-result.js";
import type { AgentUpdateKind, AgentView, SubagentBatchUpdate } from "../domain/agent-view.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import { preflightResumeFailure, preflightSpawnFailure } from "../domain/preflight-failure.js";
import type { ResumeRequest, TaskRequest, SessionStatus } from "../schema.js";
import { activeOrRetainedAgents, effectiveStatus } from "../view/view-helpers.js";
import { ResumeAgent, RunAgent } from "./run-agent.js";
import { TaskQueue } from "./task-queue.js";
import { timingMark, timingStart, timingSync } from "./timing.js";

const MESSAGE_UPDATE_THROTTLE_MS = 100;
const ANIMATION_UPDATE_INTERVAL_MS = 120;

export type AgentManagerUpdateListener = (update: SubagentBatchUpdate) => void;
export type AgentRunner = (ctx: ExtensionContext, agent: Agent, prompt: string, signal?: AbortSignal) => Promise<AgentRunResult>;
export type AgentResumeRunner = (ctx: ExtensionContext, agent: Agent, prompt: string, signal?: AbortSignal) => Promise<AgentRunResult>;

export type BackgroundResult =
  | { sessionId: string; ready: true; result: AgentRunResult }
  | { sessionId: string; ready: false; status: "queued" | "running"; elapsedMs: number; agent: string; label?: string }
  | { sessionId: string; error: string };

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
  background: boolean;
  controller?: AbortController;
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

  listSessions(filter?: { status?: SessionStatus[] }): AgentView[] {
    const views = activeOrRetainedAgents(this._agents).map(agent => agent.toView());
    if (!filter || filter.status === undefined) return views;
    const allowed = new Set(filter.status);
    return views.filter(view => allowed.has(effectiveStatus(view.status) as SessionStatus));
  }

  configure(options: { maxRunning?: number }) {
    if (options.maxRunning !== undefined) this._queue.maxRunning = options.maxRunning;
  }

  async backgroundResults(
    sessionIds: string[],
    options: { remove?: boolean } = {},
  ): Promise<BackgroundResult[]> {
    const remove = options.remove === true;
    const results: BackgroundResult[] = [];
    for (const id of sessionIds) {
      const agent = this._agents.find(a => a.id === id);
      if (!agent) {
        results.push({ sessionId: id, error: `Unknown subagent session: ${id}` });
        continue;
      }
      const status = agent.status;
      if (status.kind === "done" || status.kind === "resumeFailed") {
        results.push({ sessionId: id, ready: true, result: status.result });
        if (remove) await this.remove({ sessionIds: [id] });
        continue;
      }
      const now = Date.now();
      const elapsedMs = status.kind === "running"
        ? now - status.startedAt
        : now - agent.createdAt;
      const entry: Extract<BackgroundResult, { ready: false }> = {
        sessionId: id,
        ready: false,
        status: status.kind === "running" ? "running" : "queued",
        elapsedMs,
        agent: agent.agentName,
      };
      if (agent.label !== undefined) entry.label = agent.label;
      results.push(entry);
    }
    return results;
  }

  async remove(
    args: { sessionIds: string[] } | { scope: "background" | "retained" | "non-running" },
  ): Promise<{ removed: number; aborted: number; sessionIds: string[]; errors: Array<{ sessionId: string; error: string }> }> {
    const errors: Array<{ sessionId: string; error: string }> = [];
    const targets: Agent[] = [];

    if ("sessionIds" in args) {
      for (const id of args.sessionIds) {
        const agent = this._agents.find(a => a.id === id);
        if (!agent) errors.push({ sessionId: id, error: `Unknown subagent session: ${id}` });
        else targets.push(agent);
      }
    } else {
      targets.push(...this._matchScope(args.scope));
    }

    let aborted = 0;
    for (const agent of targets) {
      const status = agent.status.kind;
      if (status === "running" || status === "queued") {
        await agent.abort();
        if (status === "running") aborted += 1;
      }
    }

    const removedIds = new Set(targets.map(a => a.id));
    if (removedIds.size > 0) {
      this._agents = this._agents.filter(a => !removedIds.has(a.id));
      const touchedGroups = new Set<string>();
      for (const id of removedIds) {
        const groupId = this._agentBatch.get(id);
        if (groupId) touchedGroups.add(groupId);
        this._agentBatch.delete(id);
      }
      for (const groupId of touchedGroups) this._emitBatchUpdate(groupId);
    }

    return {
      removed: removedIds.size,
      aborted,
      sessionIds: Array.from(removedIds),
      errors,
    };
  }

  private _matchScope(scope: "background" | "retained" | "non-running"): Agent[] {
    if (scope === "background") return this._agents.filter(a => a.background);
    if (scope === "retained") return this._agents.filter(a => !a.background && a.status.kind !== "running" && a.resumable);
    if (scope === "non-running") return this._agents.filter(a => a.status.kind !== "running");
    throw new Error(`Unknown remove scope: ${String(scope)}`);
  }

  async run(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    tasks: TaskRequest[],
    onUpdate?: AgentManagerUpdateListener,
  ): Promise<AgentRunResult[]> {
    const batch = this.startBatch(ctx, signal, tasks, onUpdate, { background: false });
    return batch.resultsPromise;
  }

  startBatch(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    tasks: TaskRequest[],
    onUpdate: AgentManagerUpdateListener | undefined,
    options: { background: boolean },
  ): { groupId: string; sessions: AgentView[]; resultsPromise: Promise<AgentRunResult[]> } {
    const groupId = randomUUID();
    const groupCreatedAt = Date.now();
    timingMark("manager.run.start", { groupId, taskCount: tasks.length, background: options.background });

    const entries: BatchEntry[] = [];
    const controller = options.background ? new AbortController() : undefined;
    const batch: SpawnBatch = { groupId, entries, listener: onUpdate, background: options.background, controller };
    this._activeBatches.set(groupId, batch);

    const childSignal = controller ? controller.signal : signal;
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
        const agent = new Agent(
          randomUUID(),
          config,
          spawn,
          invocation,
          this._agentUpdate.bind(this),
          { background: options.background },
        );
        entries.push({ agent, inputIndex });
        timingMark("manager.task.spawnCreated", { groupId, inputIndex, agent: task.agent, sessionId: agent.id });
        this._agents.push(agent);
        this._agentBatch.set(agent.id, groupId);
        touched.add(agent);
        return this._runSpawn(ctx, childSignal, agent, task.prompt);
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

        if (options.background) target.promoteToBackground();
        entries.push({ agent: target, inputIndex, resumed: true });
        timingMark("manager.task.resumeCreated", { groupId, inputIndex, sessionId: target.id });
        this._agentBatch.set(target.id, groupId);
        touched.add(target);
        return this._runResume(ctx, childSignal, target, task);
      }
    });

    timingMark("manager.initialEmit.before", { groupId, entries: entries.length });
    this._emitBatchUpdate(groupId);
    timingMark("manager.initialEmit.after", { groupId });

    const sessions = this._snapshotEntries(batch.entries);

    const resultsPromise = Promise.all(resultPromises)
      .then(results => {
        this._agents = this._agents.filter(agent => {
          if (!touched.has(agent)) return true;
          if (agent.background) return true;
          if (agent.status.kind !== "done") return true;
          if (agent.resumable) return true;
          this._agentBatch.delete(agent.id);
          return false;
        });
        timingMark("manager.run.results", { groupId, resultCount: results.length });
        return results;
      })
      .finally(() => {
        this._flushPendingMessageUpdate(batch);
        this._clearAnimationUpdate(batch);
        this._activeBatches.delete(groupId);
      });

    return { groupId, sessions, resultsPromise };
  }

  private _snapshotEntries(entries: BatchEntry[]): AgentView[] {
    return entries
      .slice()
      .sort((a, b) => a.inputIndex - b.inputIndex)
      .map(({ agent, view, inputIndex, resumed }) => {
        const baseView = view ?? (agent ? agent.toView(inputIndex) : view!);
        return { ...baseView, resumed: Boolean(resumed) };
      });
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
      const currentStatus = agent.status as Agent["status"];
      if (currentStatus.kind === "done") {
        end({ status: currentStatus.result.status });
        return currentStatus.result;
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
        if (!this._agents.includes(target)) {
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
    const sessions = this._snapshotEntries(batch.entries);
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
