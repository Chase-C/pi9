import { Usage } from "@mariozechner/pi-ai";
import { AgentSession } from "@mariozechner/pi-coding-agent";

import { AgentConfig } from "./agent-config.js";
import type { AgentRunResult } from "./agent-result.js";
import type { AgentToolUse, AgentUpdateKind, AgentView, AgentViewStatus } from "./agent-view.js";
import type { AgentOptions } from "../schema.js";
import { MESSAGE_SNIPPET_LENGTH, OUTPUT_SNIPPET_LENGTH, compact } from "../view/view-helpers.js";

const DefaultUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export type AgentStatus =
  | { kind: "queued" }
  | { kind: "running"; session: AgentSession; startedAt: number }
  | { kind: "done"; result: AgentRunResult; ran?: { session: AgentSession; startedAt: number }; completedAt: number };

export class Agent {

  private _status: AgentStatus = { kind: "queued" };

  private _label: string | undefined;

  private _message: string = "";

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
    private readonly options: AgentOptions,
    private readonly onUpdate: (agent: Agent, kind: AgentUpdateKind) => void,
  ) {
    this._label = options.label;
  }

  get agentName() { return this.options.agent }
  get label() { return this._label }
  setLabel(label: string | undefined) {
    this._label = label;
    this.onUpdate(this, "status");
  }
  get modelOverride() { return this.options.model }
  get thinkingOverride() { return this.options.thinking }
  get cwd() { return this.options.cwd }

  get status() { return this._status }

  get message() { return this._message }
  get activeTools() { return this._toolHistory.filter(tool => tool.completedAt === undefined).map(tool => tool.name) }
  get toolHistory(): readonly AgentToolUse[] { return this._toolHistory }

  get turns() { return this._turns }
  get toolUses() { return this._toolHistory.length }
  get compactions() { return this._compactions }

  get totalUsage() { return this._totalUsage }

  get createdAt() { return this._createdAt }

  get resolvedModel() { return this.modelOverride ?? this.config.model }
  get resolvedThinking() { return this.thinkingOverride ?? this.config.thinking }

  get resumable(): boolean {
    if (!this.config.resumable) return false;
    if (this._status.kind !== "done") return true;
    return Boolean(this._status.ran);
  }

  toView(inputIndex?: number): AgentView {
    return {
      id: this.id,
      ...(inputIndex !== undefined ? { inputIndex } : {}),
      ...(this._label !== undefined ? { label: this._label } : {}),
      createdAt: this._createdAt,
      config: {
        name: this.agentName,
        description: this.config.description,
        source: this.config.source,
        sourcePath: this.config.sourcePath,
        model: this.resolvedModel,
        thinking: this.resolvedThinking,
        tools: this.config.tools,
        resumable: this.resumable,
      },
      status: this._viewStatus(),
      activity: {
        messageSnippet: this._message ? compact(this._message, MESSAGE_SNIPPET_LENGTH) : undefined,
        turns: this._turns,
        compactions: this._compactions,
        toolHistory: this._toolHistory.map(tool => ({ ...tool })),
      },
      usage: this._totalUsage,
    };
  }

  attach(session: AgentSession) {
    const canAttach =
      this._status.kind === "queued" ||
      (this._status.kind === "done" && this._status.result.status === "completed");
    if (!canAttach) {
      throw new Error(`Cannot attach a session to an agent that is ${this._describe()}.`);
    }
    this._subscribe(session);
    this._status = { kind: "running", session, startedAt: Date.now() };
    this.onUpdate(this, "status");
  }

  finalize(result: AgentRunResult) {
    if (this._status.kind === "done") return;
    this._finishSubscription();
    const previousStatus = this._status;
    const ran = previousStatus.kind === "running"
      ? { session: previousStatus.session, startedAt: previousStatus.startedAt }
      : undefined;
    this._status = { kind: "done", result, ran, completedAt: Date.now() };
    this.onUpdate(this, "status");
  }

  private _viewStatus(): AgentViewStatus {
    if (this._status.kind === "queued") return { kind: "queued" };
    if (this._status.kind === "running") return { kind: "running", startedAt: this._status.startedAt };

    const result = this._status.result;
    const rawSnippet = result.status === "completed" ? result.output : result.error ?? result.status;
    return {
      kind: "done",
      outcome: result.status,
      completedAt: this._status.completedAt,
      ...(this._status.ran ? { startedAt: this._status.ran.startedAt } : {}),
      ...(rawSnippet ? { snippet: compact(rawSnippet, OUTPUT_SNIPPET_LENGTH) } : {}),
    };
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
