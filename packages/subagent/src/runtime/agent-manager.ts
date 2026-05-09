import { randomUUID } from "node:crypto";

import { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import {
  errorRun,
  finalizeRun,
  interruptedRun,
  type AgentRunResult,
} from "../domain/agent-result.js";
import type { AgentUpdateKind, AgentView, SubagentBatchUpdate } from "../domain/agent-view.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentOptions } from "../schema.js";
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
        this._agents = this._agents.filter(a => a.id !== sessionId);
        if (agent.status.kind === "running") {
          finalizeRun(agent, "", { status: "aborted", error: "Agent aborted." });
        } else {
          this._emitBatchUpdate(agent.groupId);
        }
      }

      return { cleared, sessionId };
    }

    const retained = this._agents.filter(agent => {
      return agent.status.kind == "queued" || agent.status.kind == "running";
    });

    const cleared = this._agents.length - retained.length;
    this._agents = retained;
    for (const agent of retained) this._emitBatchUpdate(agent.groupId);

    return { cleared };
  }

  async spawn(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    options: Array<AgentOptions>,
    onUpdate?: AgentManagerUpdateListener,
  ): Promise<Array<AgentRunResult>> {
    const groupId = randomUUID();
    const groupCreatedAt = Date.now();
    const available = () => Array
      .from(this.registry.agents.values())
      .map((agent) => `${agent.name} (${agent.source})`)
      .join("\n");

    const entries: BatchEntry[] = [];
    const batch: SpawnBatch = { groupId, entries, listener: onUpdate };
    this._activeBatches.set(groupId, batch);

    const resultPromises = options.map((opts, inputIndex) => {
      const config = this.registry.agents.get(opts.agent);
      if (!config) {
        const error = `Unknown agent: ${opts.agent}. Available agents:\n${available()}`;
        entries.push({
          view: {
            id: `${groupId}:task-${inputIndex}`,
            inputIndex,
            ...(opts.label !== undefined ? { label: opts.label } : {}),
            createdAt: groupCreatedAt,
            config: {
              name: opts.agent,
              model: opts.model,
              thinking: opts.thinking,
              source: undefined,
              tools: undefined,
              resumable: false,
            },
            status: {
              kind: "done",
              outcome: "error",
              completedAt: groupCreatedAt,
              snippet: error,
            },
            activity: {
              turns: 0,
              compactions: 0,
              toolHistory: [],
            },
            usage: undefined,
          },
          inputIndex,
        });

        return Promise.resolve({
          agent: opts.agent,
          ...(opts.label !== undefined ? { label: opts.label } : {}),
          prompt: opts.prompt,
          status: "error",
          error,
          model: opts.model,
          resumable: false,
        } as AgentRunResult);
      }

      const agent = new Agent(randomUUID(), groupId, config, opts, this._agentUpdate.bind(this));
      entries.push({ agent, inputIndex });
      this._agents.push(agent);
      return this._enqueue(ctx, signal, agent, opts.prompt);
    });

    this._emitBatchUpdate(groupId);
    try {
      const results = await Promise.all(resultPromises);
      this._agents = this._agents.filter(agent => {
        if (agent.groupId !== groupId) return true;
        if (agent.status.kind !== "done") return true;
        return agent.resumable;
      });

      return results;
    } finally {
      this._flushPendingMessageUpdate(batch);
      this._activeBatches.delete(groupId);
    }
  }

  async resume(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    sessionId: string,
    prompt: string,
    onUpdate?: AgentManagerUpdateListener,
  ): Promise<AgentRunResult> {
    const agent = this._agents.find(a => a.id === sessionId && a.resumable);
    if (!agent) {
      throw new Error(`Unknown resumable subagent session: ${sessionId}`);
    }
    if (agent.status.kind !== "done" || agent.status.result.status !== "completed") {
      const detail = agent.status.kind === "done" ? agent.status.result.status : agent.status.kind;
      throw new Error(`Cannot resume subagent session ${sessionId} while it is ${detail}.`);
    }

    const batch: SpawnBatch = {
      groupId: agent.groupId,
      entries: [{ agent, inputIndex: 0 }],
      listener: onUpdate,
    };
    this._activeBatches.set(agent.groupId, batch);

    const originalStatus = agent.status;
    try {
      return await this._resumeAgent(ctx, agent, prompt, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (agent.status === originalStatus) {
        return {
          agent: agent.agentName,
          ...(agent.label !== undefined ? { label: agent.label } : {}),
          prompt,
          status: "error",
          error: message,
          model: agent.modelOverride ?? agent.config.model,
          resumable: agent.resumable,
          sessionId: agent.id,
        };
      }
      return errorRun(agent, prompt, message);
    } finally {
      this._flushPendingMessageUpdate(batch);
      this._activeBatches.delete(agent.groupId);
    }
  }

  private _agentUpdate(agent: Agent, kind: AgentUpdateKind) {
    const batch = this._activeBatches.get(agent.groupId);
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
    this._emitBatchUpdate(agent.groupId);
  }

  private _enqueue(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    agent: Agent,
    prompt: string,
  ): Promise<AgentRunResult> {
    const skipped = () => finalizeRun(agent, prompt, { status: "skipped", error: "Agent skipped." });
    return this._queue.enqueue(async () => {
      if (signal?.aborted) return skipped();
      try {
        return await this._runAgent(ctx, agent, prompt, signal);
      } catch (error) {
        if (agent.status.kind === "done") return agent.status.result;
        const message = error instanceof Error ? error.message : String(error);
        if (signal?.aborted) {
          return agent.status.kind === "queued" ? skipped() : interruptedRun(agent, prompt, message);
        }
        return errorRun(agent, prompt, message);
      }
    });
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
      .map(({ agent, view, inputIndex }) => agent ? agent.toView(inputIndex) : view!);
    const active = sessions.some(s => s.status.kind === "queued" || s.status.kind === "running");
    batch.listener({ sessions, active });
  }
}
