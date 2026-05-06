import { randomUUID } from "node:crypto";

import { ModelThinkingLevel } from "@mariozechner/pi-ai";
import { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { Agent, type AgentUpdateKind } from "./agent.js";
import { AgentRegistry } from "./agent-registry.js";
import { ResumeAgent, RunAgent, type RunResult } from "./run-agent.js";
import {
  agentToSessionDto,
  activeOrRetainedSessions,
  createSubagentErrorSessionDto,
  createSubagentGroupDto,
  type SubagentGroupDto,
  type SubagentGroupUpdateDto,
  type SubagentSessionDto,
} from "./subagent-ui.js";

const MESSAGE_UPDATE_THROTTLE_MS = 100;

export interface AgentOptions {
  agent: string;
  prompt: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
}

export interface AgentRunResult {
  agent: string;
  prompt: string;
  status: "completed" | "error" | "aborted";
  output?: string;
  error?: string;
  model?: string;
  sessionId?: string;
  resumable?: boolean;
}

export interface AgentRunSuccess {
  kind: "completed";
  sessionId: string;
  agent: string;
  prompt: string;
  output: string;
}

export type AgentManagerUpdateListener = (update: SubagentGroupUpdateDto) => void;
export type AgentRunner = (ctx: ExtensionContext, agent: Agent, signal?: AbortSignal) => Promise<RunResult>;
export type AgentResumeRunner = (ctx: ExtensionContext, agent: Agent, prompt: string, signal?: AbortSignal) => Promise<RunResult>;

type SubagentGroupEntry =
  | { kind: "agent"; agent: Agent; inputIndex: number }
  | { kind: "session"; session: SubagentSessionDto };

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

  get sessions() {
    return this.listSessions();
  }

  listSessions(): SubagentSessionDto[] {
    return activeOrRetainedSessions(this._agents.map(agentToSessionDto));
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
          agent.abort();
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
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    options: Array<AgentOptions>,
    onUpdate?: AgentManagerUpdateListener,
  ): Promise<Array<AgentRunResult>> {
    (pi)

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
          kind: "session",
          session: createSubagentErrorSessionDto(`${groupId}:task-${inputIndex}`, groupId, opts, error, groupCreatedAt, inputIndex),
        });
        return Promise.resolve({
          agent: opts.agent,
          prompt: opts.prompt,
          status: "error" as const,
          error,
          model: opts.model,
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
  ): Promise<AgentRunResult> {
    const agent = this._agents.find(a => a.id === sessionId && a.config.resumable);
    if (!agent) {
      throw new Error(`Unknown resumable subagent session: ${sessionId}`);
    }
    if (agent.status.kind !== "completed") {
      throw new Error(`Cannot resume subagent session ${sessionId} while it is ${agent.status.kind}.`);
    }

    try {
      const { response } = await this._resumeAgent(ctx, agent, prompt, signal);
      return this._resultFromAgent(agent, prompt, response);
    } catch (error) {
      try {
        agent.error(error instanceof Error ? error.message : String(error));
      } catch { }

      return this._resultFromAgent(agent, prompt, undefined, error);
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
    return new Promise(resolve => {
      const abortQueued = () => {
        if (agent.status.kind === "queued") agent.cancelQueued();
        resolve(this._resultFromAgent(agent, agent.options.prompt));
      };

      if (signal?.aborted) {
        abortQueued();
        return;
      }

      this._queue.push(() => {
        if (signal?.aborted) {
          abortQueued();
          this._flushQueue();
          return;
        }

        const run = this._runAgent(ctx, agent, signal)
          .then(({ response }) => response);

        agent.trackRun(run);
        agent.run.catch(() => { });

        run.then(
          output => {
            resolve(this._resultFromAgent(agent, agent.options.prompt, output));
          },
          error => {
            const message = error instanceof Error ? error.message : String(error);
            if (agent.status.kind === "running") {
              agent.error(message);
            } else if (agent.status.kind === "queued") {
              agent.failQueued(message);
            }
            resolve(this._resultFromAgent(agent, agent.options.prompt, undefined, error));
          },
        ).finally(() => this._flushQueue());
      });
    });
  }

  private _resultFromAgent(
    agent: Agent,
    prompt: string,
    output?: string,
    error?: unknown,
  ): AgentRunResult {
    const base = {
      agent: agent.options.agent,
      prompt,
      model: agent.options.model ?? agent.config.model,
      resumable: Boolean(agent.config.resumable),
      ...(agent.config.resumable ? { sessionId: agent.id } : {}),
    };

    if (agent.status.kind === "completed") {
      return { ...base, status: "completed", output: output ?? agent.status.response };
    }
    if (output !== undefined) {
      return { ...base, status: "completed", output };
    }
    if (agent.status.kind === "aborted") {
      return { ...base, status: "aborted", error: "Agent aborted." };
    }
    if (agent.status.kind === "error") {
      return { ...base, status: "error", error: agent.status.error };
    }
    return {
      ...base,
      status: "error",
      error: error instanceof Error ? error.message : String(error ?? "Agent failed."),
    };
  }

  private _releaseNonResumableCompleted(groupId: string) {
    this._agents = this._agents.filter(agent => {
      if (agent.groupId !== groupId) return true;
      if (agent.config.resumable) return true;
      return agent.status.kind === "queued" || agent.status.kind === "running";
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

    const group = this._groupDto(groupId);
    const sessions = group.sessions;
    const update: SubagentGroupUpdateDto = {
      groupId,
      group,
      sessions,
      active: sessions.some(session => session.status === "queued" || session.status === "running"),
      updatedAt: Date.now(),
    };

    for (const listener of listeners) listener(update);
  }

  private _groupDto(groupId: string): SubagentGroupDto {
    const group = this._groups.get(groupId);
    if (!group) {
      const sessions = this._agents
        .filter(agent => agent.groupId === groupId)
        .map(agentToSessionDto);
      return createSubagentGroupDto(groupId, Date.now(), sessions);
    }

    const sessions = group.entries.map(entry => {
      if (entry.kind === "session") return entry.session;
      return { ...agentToSessionDto(entry.agent), inputIndex: entry.inputIndex };
    });
    return createSubagentGroupDto(group.id, group.createdAt, sessions);
  }
}
