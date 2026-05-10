import { randomUUID } from "node:crypto";

import { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import type { AgentInvocation, AgentSpawn } from "../domain/agent-invocation.js";
import {
  errorRun,
  finalizeRun,
  interruptedRun,
  type AgentRunResult,
} from "../domain/agent-result.js";
import type { AgentUpdateKind, AgentView, SubagentBatchUpdate } from "../domain/agent-view.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import type { TaskRequest } from "../schema.js";
import { activeOrRetainedAgents } from "../view/view-helpers.js";
import { ResumeAgent, RunAgent } from "./run-agent.js";
import { TaskQueue } from "./task-queue.js";

const MESSAGE_UPDATE_THROTTLE_MS = 100;

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

  clear(sessionId?: string): { cleared: number; sessionId?: string } {
    if (sessionId) {
      const agent = this._agents.find(a => a.id === sessionId);
      let cleared = 0;
      if (agent) {
        cleared = 1;
        const groupId = this._agentBatch.get(agent.id);
        this._agents = this._agents.filter(a => a.id !== sessionId);
        this._agentBatch.delete(agent.id);
        if (agent.status.kind === "running") {
          finalizeRun(agent, "", { status: "aborted", error: "Agent aborted." });
        } else if (groupId) {
          this._emitBatchUpdate(groupId);
        }
      }

      return { cleared, sessionId };
    }

    const retained = this._agents.filter(agent => {
      return agent.status.kind == "queued" || agent.status.kind == "running";
    });

    for (const agent of this._agents) {
      if (!retained.includes(agent)) this._agentBatch.delete(agent.id);
    }
    const cleared = this._agents.length - retained.length;
    this._agents = retained;
    for (const agent of retained) {
      const groupId = this._agentBatch.get(agent.id);
      if (groupId) this._emitBatchUpdate(groupId);
    }

    return { cleared };
  }

  async run(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    tasks: TaskRequest[],
    onUpdate?: AgentManagerUpdateListener,
  ): Promise<AgentRunResult[]> {
    const groupId = randomUUID();
    const groupCreatedAt = Date.now();
    const available = () => Array
      .from(this.registry.agents.values())
      .map((agent) => `${agent.name} (${agent.source})`)
      .join("\n");

    const entries: BatchEntry[] = [];
    const batch: SpawnBatch = { groupId, entries, listener: onUpdate };
    this._activeBatches.set(groupId, batch);

    const touched = new Set<Agent>();

    const resultPromises = tasks.map((task, inputIndex) => {
      if (task.kind === "spawn") {
        const config = this.registry.agents.get(task.agent);
        if (!config) {
          const error = `Unknown agent: ${task.agent}. Available agents:\n${available()}`;
          entries.push({
            view: {
              id: `${groupId}:task-${inputIndex}`,
              inputIndex,
              ...(task.label !== undefined ? { label: task.label } : {}),
              createdAt: groupCreatedAt,
              config: {
                name: task.agent,
                model: task.model,
                thinking: task.thinking,
                source: undefined,
                tools: undefined,
                resumable: false,
              },
              status: { kind: "done", outcome: "error", completedAt: groupCreatedAt, snippet: error },
              activity: { turns: 0, compactions: 0, toolHistory: [] },
              usage: undefined,
            },
            inputIndex,
          });
          return Promise.resolve<AgentRunResult>({
            agent: task.agent,
            ...(task.label !== undefined ? { label: task.label } : {}),
            prompt: task.prompt,
            status: "error",
            error,
            model: task.model,
            resumable: false,
            resumed: false,
          });
        }

        const spawn: AgentSpawn = {
          agent: task.agent,
          ...(task.skills !== undefined ? { skills: task.skills } : {}),
          ...(task.model !== undefined ? { model: task.model } : {}),
          ...(task.thinking !== undefined ? { thinking: task.thinking } : {}),
          ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
        };
        const invocation: AgentInvocation = {
          prompt: task.prompt,
          ...(task.label !== undefined ? { label: task.label } : {}),
          ...(task.resumable !== undefined ? { resumable: task.resumable } : {}),
        };

        const agent = new Agent(randomUUID(), config, spawn, invocation, this._agentUpdate.bind(this));
        entries.push({ agent, inputIndex });
        this._agents.push(agent);
        this._agentBatch.set(agent.id, groupId);
        touched.add(agent);
        return this._enqueueRun(ctx, signal, agent, task.prompt, false);
      }
      // task.kind === "resume"
      else {
        const target = this._agents.find(a => a.id === task.sessionId && a.resumable);
        const isInvalidStatus = target && (target.status.kind !== "done" || target.status.result.status !== "completed");
        const isReserved = target && this._reservedResumeSessionIds.has(target.id);
        if (!target || isInvalidStatus || isReserved) {
          const error = !target
            ? `Unknown resumable subagent session: ${task.sessionId}`
            : isReserved
              ? `Cannot resume subagent session ${task.sessionId} while it is already being resumed.`
              : (() => {
                  const detail = target.status.kind === "done" ? target.status.result.status : target.status.kind;
                  return `Cannot resume subagent session ${task.sessionId} while it is ${detail}.`;
                })();
          const labelForView = task.label ?? target?.label;
          entries.push({
            view: {
              id: target ? target.id : `${groupId}:resume-${inputIndex}`,
              inputIndex,
              ...(labelForView !== undefined ? { label: labelForView } : {}),
              createdAt: groupCreatedAt,
              config: target?.toView().config ?? {
                name: "(unknown)",
                source: undefined,
                model: undefined,
                thinking: undefined,
                tools: undefined,
                resumable: false,
              },
              status: { kind: "done", outcome: "error", completedAt: groupCreatedAt, snippet: error },
              activity: { turns: 0, compactions: 0, toolHistory: [] },
              usage: undefined,
            },
            inputIndex,
            resumed: true,
          });
          return Promise.resolve<AgentRunResult>({
            agent: target?.agentName ?? "(unknown)",
            ...(labelForView !== undefined ? { label: labelForView } : {}),
            prompt: task.prompt,
            status: "error",
            error,
            model: target ? (target.spawn.model ?? target.config.model) : undefined,
            resumable: target?.resumable ?? false,
            resumed: true,
            ...(target ? { sessionId: target.id } : {}),
          });
        }

        this._reservedResumeSessionIds.add(target.id);
        const invocation: AgentInvocation = {
          prompt: task.prompt,
          ...(task.label !== undefined ? { label: task.label } : {}),
          ...(task.resumable !== undefined ? { resumable: task.resumable } : {}),
        };
        const undo = target.apply(invocation);
        this._agentBatch.set(target.id, groupId);
        const entry: BatchEntry = { agent: target, inputIndex, resumed: true };
        entries.push(entry);
        touched.add(target);
        return this._enqueueRun(ctx, signal, target, task.prompt, true, undo, result => {
          entry.view = this._syntheticResumeView(target, inputIndex, result);
          this._emitBatchUpdate(groupId);
        }).finally(() => {
          this._reservedResumeSessionIds.delete(target.id);
        });
      }
    });

    this._emitBatchUpdate(groupId);
    try {
      const results = await Promise.all(resultPromises);
      this._agents = this._agents.filter(agent => {
        if (!touched.has(agent)) return true;
        if (agent.status.kind !== "done") return true;
        if (agent.resumable) return true;
        this._agentBatch.delete(agent.id);
        return false;
      });
      return results;
    } finally {
      this._flushPendingMessageUpdate(batch);
      this._activeBatches.delete(groupId);
    }
  }

  private _agentUpdate(agent: Agent, kind: AgentUpdateKind) {
    const groupId = this._agentBatch.get(agent.id);
    if (!groupId) return;
    const batch = this._activeBatches.get(groupId);
    if (!batch) return;
    if (kind === "message") {
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

  private _enqueueRun(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    agent: Agent,
    prompt: string,
    resume: boolean,
    undo?: () => void,
    onPreAttachResult?: (result: AgentRunResult) => void,
  ): Promise<AgentRunResult> {
    // For a resume, the agent enters this method already in `done(completed)`. Capture that so
    // we can detect a runner that throws before re-attaching, and surface the resume failure
    // without overwriting the prior completion.
    const originalStatus = resume ? agent.status : undefined;
    const preAttachResult = (status: "skipped" | "error", error: string): AgentRunResult => {
      const result: AgentRunResult = {
        agent: agent.agentName,
        ...(agent.label !== undefined ? { label: agent.label } : {}),
        prompt,
        status,
        error,
        model: agent.spawn.model ?? agent.config.model,
        resumable: agent.resumable,
        resumed: true,
        ...(agent.resumable ? { sessionId: agent.id } : {}),
      };
      onPreAttachResult?.(result);
      return result;
    };
    const skipped = () => resume && agent.status.kind === "done"
      ? preAttachResult("skipped", "Agent skipped.")
      : finalizeRun(agent, prompt, { status: "skipped", error: "Agent skipped.", resumed: resume });

    return this._queue.enqueue(async () => {
      if (signal?.aborted) {
        if (resume) undo?.();
        return skipped();
      }
      const runner = resume ? this._resumeAgent : this._runAgent;
      try {
        const result = await runner(ctx, agent, prompt, signal);
        return resume && !result.resumed ? { ...result, resumed: true } : result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (resume && agent.status === originalStatus) {
          undo?.();
          return preAttachResult("error", message);
        }
        if (agent.status.kind === "done") return agent.status.result;
        if (signal?.aborted) {
          return agent.status.kind === "queued" ? skipped() : interruptedRun(agent, prompt, message, resume);
        }
        return errorRun(agent, prompt, message, resume);
      }
    });
  }

  private _syntheticResumeView(agent: Agent, inputIndex: number, result: AgentRunResult): AgentView {
    const baseView = agent.toView(inputIndex);
    return {
      ...baseView,
      config: { ...baseView.config, resumable: result.resumable },
      status: {
        kind: "done",
        outcome: result.status,
        completedAt: Date.now(),
        ...(result.error ? { snippet: result.error } : {}),
        ...(result.output ? { snippet: result.output } : {}),
      },
    };
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

    const sessions = batch.entries
      .slice()
      .sort((a, b) => a.inputIndex - b.inputIndex)
      .map(({ agent, view, inputIndex, resumed }) => {
        const baseView = view ?? (agent ? agent.toView(inputIndex) : view!);
        return { ...baseView, resumed: Boolean(resumed) };
      });
    const active = sessions.some(s => s.status.kind === "queued" || s.status.kind === "running");
    batch.listener({ sessions, active });
  }
}
