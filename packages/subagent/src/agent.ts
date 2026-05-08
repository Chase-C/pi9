import { ModelThinkingLevel, Usage } from "@mariozechner/pi-ai";
import { AgentSession } from "@mariozechner/pi-coding-agent";

import { AgentConfig, AgentSource } from "./agent-config.js";
import type { AgentOptions } from "./agent-options.js";
import type { AgentRunResult } from "./run-agent.js";

const DefaultUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export type AgentStatus =
  | { kind: "queued" }
  | { kind: "running"; session: AgentSession; startedAt: number }
  | { kind: "done"; result: AgentRunResult; ran?: { session: AgentSession; startedAt: number }; completedAt: number };

export type AgentUpdateKind = "status" | "message" | "tool" | "turn" | "usage" | "compaction";

export interface AgentPromptRun {
  readonly prompt: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly status?: AgentRunResult["status"];
}

export interface AgentToolUse {
  readonly id: string;
  readonly name: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly isError?: boolean;
}

export interface AgentView {
  readonly id: string;
  readonly groupId: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly prompts?: readonly AgentPromptRun[];
  readonly status: AgentStatus;
  readonly source: AgentSource | undefined;
  readonly resolvedModel: string | undefined;
  readonly resolvedThinking: ModelThinkingLevel | undefined;
  readonly tools: string[] | undefined;
  readonly resumable: boolean;
  readonly message: string;
  readonly activeTools?: readonly string[];
  readonly turns: number;
  readonly toolUses: number;
  readonly toolHistory?: readonly AgentToolUse[];
  readonly compactions: number;
  readonly createdAt: number;
  readonly totalUsage: Usage | undefined;
}

export class Agent implements AgentView {

  private _status: AgentStatus = { kind: "queued" };

  private _message: string = "";

  private _pendingPrompt: string | undefined;
  private _promptRuns = new Array<AgentPromptRun>();

  private _turns: number = 0;
  private _toolHistory = new Array<AgentToolUse>();
  private _nextSyntheticToolId = 0;
  private _compactions: number = 0;

  private _usage: Usage = DefaultUsage;
  private _totalUsage: Usage = DefaultUsage;

  private _createdAt: number = Date.now();

  private _unsubscribe?: () => void;

  constructor(
    readonly id: string,
    readonly groupId: string,
    readonly config: AgentConfig,
    options: AgentOptions,
    readonly onUpdate: (agent: Agent, kind: AgentUpdateKind) => void,
  ) {
    this.agentName = options.agent;
    this.modelOverride = options.model;
    this.thinkingOverride = options.thinking;
    this.cwd = options.cwd;
    this._pendingPrompt = options.prompt;
  }

  readonly agentName: string;
  readonly modelOverride: string | undefined;
  readonly thinkingOverride: ModelThinkingLevel | undefined;
  readonly cwd: string | undefined;

  get status() { return this._status }
  get hasPendingPrompt() { return this._pendingPrompt !== undefined }

  get message() { return this._message }
  get prompts(): readonly AgentPromptRun[] { return this._promptRuns }
  get prompt() { return this._pendingPrompt ?? this._promptRuns.at(-1)?.prompt ?? "" }
  get activeTools() { return this._toolHistory.filter(tool => tool.completedAt === undefined).map(tool => tool.name) }
  get toolHistory(): readonly AgentToolUse[] { return this._toolHistory }

  get turns() { return this._turns }
  get toolUses() { return this._toolHistory.length }
  get compactions() { return this._compactions }

  get usage() { return this._usage }
  get totalUsage() { return this._totalUsage }

  get createdAt() { return this._createdAt }

  get source() { return this.config.source }
  get resolvedModel() { return this.modelOverride ?? this.config.model }
  get resolvedThinking() { return this.thinkingOverride ?? this.config.thinking }
  get tools() { return this.config.tools }

  get resumable(): boolean {
    if (!this.config.resumable) return false;
    if (this._status.kind !== "done") return true;
    return Boolean(this._status.ran);
  }

  preparePrompt(prompt: string) {
    this._pendingPrompt = prompt;
  }

  discardPendingPrompt() {
    this._pendingPrompt = undefined;
  }

  finishPrompt(status: AgentRunResult["status"]) {
    const i = this._activeRunIndex();
    if (i < 0) return;
    this._promptRuns[i] = { ...this._promptRuns[i], completedAt: Date.now(), status };
  }

  attach(session: AgentSession) {
    const canAttach =
      this._status.kind === "queued" ||
      (this._status.kind === "done" && this._status.result.status === "completed");
    if (!canAttach) {
      throw new Error(`Cannot attach a session to an agent that is ${this._describe()}.`);
    }
    if (this._pendingPrompt !== undefined) {
      this._promptRuns.push({ prompt: this._pendingPrompt, startedAt: Date.now() });
      this._pendingPrompt = undefined;
    }
    this._subscribe(session);
    this._status = { kind: "running", session, startedAt: Date.now() };
    this.onUpdate(this, "status");
  }

  finalize(result: AgentRunResult) {
    if (this._status.kind === "done" && !this.hasPendingPrompt) return;
    this._finishSubscription();
    const previousStatus = this._status;
    const ran = previousStatus.kind === "running"
      ? { session: previousStatus.session, startedAt: previousStatus.startedAt }
      : previousStatus.kind === "done"
        ? previousStatus.ran
        : undefined;
    if (previousStatus.kind === "done" && this._pendingPrompt !== undefined) {
      const now = Date.now();
      this._promptRuns.push({ prompt: this._pendingPrompt, startedAt: now, completedAt: now, status: result.status });
      this._pendingPrompt = undefined;
    }
    this._status = { kind: "done", result, ran, completedAt: Date.now() };
    this.onUpdate(this, "status");
  }

  private _describe(): string {
    if (this._status.kind === "done") return `done (${this._status.result.status})`;
    return this._status.kind;
  }

  private _finishSubscription() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
  }

  private _activeRunIndex() {
    for (let i = this._promptRuns.length - 1; i >= 0; i--) {
      if (this._promptRuns[i].completedAt === undefined) return i;
    }
    return -1;
  }

  private _startToolUse(event: { toolCallId?: string; toolName: string }) {
    this._toolHistory.push({
      id: event.toolCallId ?? `tool-${++this._nextSyntheticToolId}`,
      name: event.toolName,
      startedAt: Date.now(),
    });
  }

  private _finishToolUse(event: { toolCallId?: string; toolName?: string; isError?: boolean }) {
    const completedAt = Date.now();
    const index = this._findActiveToolUseIndex(event);
    if (index < 0) return;
    const toolUse = this._toolHistory[index];
    this._toolHistory[index] = { ...toolUse, completedAt, isError: Boolean(event.isError) };
  }

  private _findActiveToolUseIndex(event: { toolCallId?: string; toolName?: string }) {
    for (let i = this._toolHistory.length - 1; i >= 0; i--) {
      const toolUse = this._toolHistory[i];
      if (toolUse.completedAt !== undefined) continue;
      if (event.toolCallId && toolUse.id !== event.toolCallId) continue;
      if (!event.toolCallId && event.toolName && toolUse.name !== event.toolName) continue;
      return i;
    }
    return -1;
  }

  private _subscribe(session: AgentSession) {
    this._unsubscribe = session.subscribe(event => {
      if (event.type === "compaction_end" && !event.aborted && event.result) {
        this._compactions += 1;
        this.onUpdate(this, "compaction");
      }
      else if (event.type === "message_start") {
        this._message = "";
      }
      else if (event.type === "message_end" && event.message.role === "assistant") {
        this._usage = event.message.usage;
        this._totalUsage = CombineUsage(this._totalUsage, event.message.usage);
        this.onUpdate(this, "usage");
      }
      else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this._message += event.assistantMessageEvent.delta;
        this.onUpdate(this, "message");
      }
      else if (event.type === "tool_execution_start") {
        this._startToolUse(event);
        this.onUpdate(this, "tool");
      }
      else if (event.type === "tool_execution_end") {
        this._finishToolUse(event);
        this.onUpdate(this, "tool");
      }
      else if (event.type === "turn_end") {
        this._turns += 1;
        this.onUpdate(this, "turn");
      }
    });
  }
}

function CombineUsage(
  a: Usage,
  b: Usage,
): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    }
  }
}
