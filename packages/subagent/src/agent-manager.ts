import { randomUUID } from "node:crypto";

import { ModelThinkingLevel } from "@mariozechner/pi-ai";
import { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { Agent, type AgentUpdateKind } from "./agent.js";
import { AgentRegistry } from "./agent-registry.js";
import { activeOrRetainedAgents } from "./serialize.js";
import {
  ResumeAgent,
  RunAgent,
  errorRun,
  finalizeRun,
  interruptedRun,
  type AgentRunResult,
} from "./run-agent.js";

export { type AgentRunResult } from "./run-agent.js";

export interface UnknownAgentError {
  options: AgentOptions;
  error: string;
  createdAt: number;
  inputIndex: number;
}

export interface AgentManagerGroupUpdate {
  groupId: string;
  createdAt: number;
  agents: Array<{ agent: Agent; inputIndex: number }>;
  errors: UnknownAgentError[];
  active: boolean;
  updatedAt: number;
}

const MESSAGE_UPDATE_THROTTLE_MS = 100;

export interface AgentOptions {
  agent: string;
  prompt: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
}

export type AgentManagerUpdateListener = (update: AgentManagerGroupUpdate) => void;
export type AgentRunner = (ctx: ExtensionContext, agent: Agent, signal?: AbortSignal) => Promise<AgentRunResult>;
export type AgentResumeRunner = (ctx: ExtensionContext, agent: Agent, prompt: string, signal?: AbortSignal) => Promise<AgentRunResult>;

type SubagentGroupEntry =
  | { kind: "agent"; agent: Agent; inputIndex: number }
  | { kind: "error"; error: UnknownAgentError };

interface SubagentGroupState {
  id: string;
  createdAt: number;
  entries: SubagentGroupEntry[];
}

export class AgentManager {

  private _agents = new Array<Agent>();
  private _queue = new Array<() => void>();
  private _listeners = new Map<string, Set<AgentManagerUpdateListener>>();
  private _messageTimers = new Map<string, NodeJS.Timeout>();
  private _groups = new Map<string, SubagentGroupState>();

  constructor(
    readonly registry: AgentRegistry,
    readonly maxRunning: number = 4,
    private readonly _runAgent: AgentRunner = RunAgent,
    private readonly _resumeAgent: AgentResumeRunner = ResumeAgent,
  ) { }

  get numRunning() {
    return this._agents.filter(a => a.status.kind == "running").length;
  }

  get sessions(): Agent[] {
    return activeOrRetainedAgents(this._agents);
  }

  subscribe(groupId: string, listener: AgentManagerUpdateListener): () => void {
    let listeners = this._listeners.get(groupId);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(groupId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this._listeners.get(groupId);
      current?.delete(listener);
      if (current?.size === 0) this._listeners.delete(groupId);
    };
  }

  clear(sessionId?: string): { cleared: number; sessionId?: string } {
    if (sessionId) {
      const agent = this._agents.find(a => a.id === sessionId);
      let cleared = 0;
      if (agent) {
        cleared = 1;
        this._agents = this._agents.filter(a => a.id !== sessionId);
        if (agent.status.kind === "running") {
          finalizeRun(agent, { status: "aborted", error: "Agent aborted." });
        } else {
          this._emitGroupUpdate(agent.groupId);
        }
      }

      return { cleared, sessionId };
    }

    const retained = this._agents.filter(agent => {
      return agent.status.kind == "queued" || agent.status.kind == "running";
    });

    const cleared = this._agents.length - retained.length;
    this._agents = retained;
    for (const agent of retained) this._emitGroupUpdate(agent.groupId);

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
    const unsubscribe = onUpdate ? this.subscribe(groupId, onUpdate) : undefined;
    const available = () => Array
      .from(this.registry.agents.values())
      .map((agent) => `${agent.name} (${agent.source})`)
      .join("\n");

    const entries: SubagentGroupEntry[] = [];
    const resultPromises = options.map((opts, inputIndex) => {
      const config = this.registry.agents.get(opts.agent);
      if (!config) {
        const error = `Unknown agent: ${opts.agent}. Available agents:\n${available()}`;
        entries.push({
          kind: "error",
          error: { options: opts, error, createdAt: groupCreatedAt, inputIndex },
        });
        return Promise.resolve({
          agent: opts.agent,
          prompt: opts.prompt,
          status: "error" as const,
          error,
          model: opts.model,
          resumable: false,
        });
      }

      const agent = new Agent(randomUUID(), groupId, config, opts, this._agentUpdate.bind(this));
      entries.push({ kind: "agent", agent, inputIndex });
      this._agents.push(agent);
      return this._enqueue(ctx, signal, agent);
    });

    this._groups.set(groupId, { id: groupId, createdAt: groupCreatedAt, entries });
    this._emitGroupUpdate(groupId);
    this._flushQueue();
    try {
      const results = await Promise.all(resultPromises);
      this._releaseNonResumableCompleted(groupId);
      return results;
    } finally {
      this._flushPendingMessageUpdate(groupId);
      unsubscribe?.();
      this._groups.delete(groupId);
    }
  }

  async resume(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    sessionId: string,
    prompt: string,
    onUpdate?: AgentManagerUpdateListener,
  ): Promise<AgentRunResult> {
    const agent = this._agents.find(a => a.id === sessionId && a.config.resumable);
    if (!agent) {
      throw new Error(`Unknown resumable subagent session: ${sessionId}`);
    }
    if (agent.status.kind !== "done" || agent.status.result.status !== "completed") {
      const detail = agent.status.kind === "done" ? agent.status.result.status : agent.status.kind;
      throw new Error(`Cannot resume subagent session ${sessionId} while it is ${detail}.`);
    }

    const unsubscribe = onUpdate ? this.subscribe(agent.groupId, onUpdate) : undefined;
    try {
      return await this._resumeAgent(ctx, agent, prompt, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorRun(agent, message, prompt);
    } finally {
      this._flushPendingMessageUpdate(agent.groupId);
      unsubscribe?.();
    }
  }

  private _agentUpdate(agent: Agent, kind: AgentUpdateKind) {
    if (kind === "message") {
      this._scheduleMessageUpdate(agent.groupId);
      return;
    }
    this._clearPendingMessageUpdate(agent.groupId);
    this._emitGroupUpdate(agent.groupId);
  }

  private _enqueue(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    agent: Agent,
  ): Promise<AgentRunResult> {
    const skipped = () => finalizeRun(agent, { status: "skipped", error: "Agent skipped." });
    return new Promise(resolve => {
      if (signal?.aborted) {
        resolve(skipped());
        return;
      }

      this._queue.push(() => {
        if (signal?.aborted) {
          resolve(skipped());
          this._flushQueue();
          return;
        }

        this._runAgent(ctx, agent, signal).then(
          result => resolve(result),
          error => {
            if (agent.status.kind === "done") {
              resolve(agent.status.result);
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            if (signal?.aborted) {
              resolve(agent.status.kind === "queued"
                ? skipped()
                : interruptedRun(agent, message));
            } else {
              resolve(errorRun(agent, message));
            }
          },
        ).finally(() => this._flushQueue());
      });
    });
  }

  private _releaseNonResumableCompleted(groupId: string) {
    this._agents = this._agents.filter(agent => {
      if (agent.groupId !== groupId) return true;
      if (agent.status.kind !== "done") return true;
      return Boolean(agent.config.resumable && agent.status.session);
    });
  }

  private _flushQueue() {
    const startNum = this.maxRunning - this.numRunning;
    for (let i = 0; i < startNum; i++) {
      const queued = this._queue.shift();
      if (!queued) return;
      queued();
    }
  }

  private _scheduleMessageUpdate(groupId: string) {
    if (this._messageTimers.has(groupId)) return;
    const timer = setTimeout(() => {
      this._messageTimers.delete(groupId);
      this._emitGroupUpdate(groupId);
    }, MESSAGE_UPDATE_THROTTLE_MS);
    this._messageTimers.set(groupId, timer);
  }

  private _flushPendingMessageUpdate(groupId: string) {
    if (!this._clearPendingMessageUpdate(groupId)) return;
    this._emitGroupUpdate(groupId);
  }

  private _clearPendingMessageUpdate(groupId: string) {
    const timer = this._messageTimers.get(groupId);
    if (!timer) return false;
    clearTimeout(timer);
    this._messageTimers.delete(groupId);
    return true;
  }

  private _emitGroupUpdate(groupId: string) {
    const listeners = this._listeners.get(groupId);
    if (!listeners || listeners.size === 0) return;

    const update = this._buildUpdate(groupId);
    for (const listener of listeners) listener(update);
  }

  private _buildUpdate(groupId: string): AgentManagerGroupUpdate {
    const group = this._groups.get(groupId);
    const agents: AgentManagerGroupUpdate["agents"] = [];
    const errors: UnknownAgentError[] = [];
    let createdAt: number;

    if (group) {
      createdAt = group.createdAt;
      for (const entry of group.entries) {
        if (entry.kind === "error") errors.push(entry.error);
        else agents.push({ agent: entry.agent, inputIndex: entry.inputIndex });
      }
    } else {
      createdAt = Date.now();
      const groupAgents = this._agents.filter(agent => agent.groupId === groupId);
      groupAgents.forEach((agent, i) => agents.push({ agent, inputIndex: i }));
    }

    const active = agents.some(({ agent }) => agent.status.kind === "queued" || agent.status.kind === "running");
    return { groupId, createdAt, agents, errors, active, updatedAt: Date.now() };
  }
}
