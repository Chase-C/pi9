import { ModelThinkingLevel, Usage } from "@mariozechner/pi-ai";
import { AgentSession } from "@mariozechner/pi-coding-agent";

import { AgentConfig, AgentSource } from "./agent-config.js";
import { AgentOptions } from "./agent-manager.js";
import { AgentRunResult } from "./run-agent.js";

const DefaultUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export type AgentStatus =
  | { kind: "queued" }
  | { kind: "running"; session: AgentSession; startedAt: number }
  | { kind: "done"; result: AgentRunResult; ran?: { session: AgentSession; startedAt: number }; completedAt: number };

export type AgentUpdateKind = "status" | "message" | "tool" | "turn" | "usage" | "compaction";

export interface AgentView {
  readonly id: string;
  readonly groupId: string;
  readonly options: AgentOptions;
  readonly status: AgentStatus;
  readonly source: AgentSource | undefined;
  readonly resolvedModel: string | undefined;
  readonly resolvedThinking: ModelThinkingLevel | undefined;
  readonly tools: string[] | undefined;
  readonly resumable: boolean;
  readonly message: string;
  readonly tool: string | undefined;
  readonly turns: number;
  readonly toolUses: number;
  readonly compactions: number;
  readonly createdAt: number;
  readonly totalUsage: Usage | undefined;
}

export class Agent implements AgentView {

  private _status: AgentStatus = { kind: "queued" };

  private _message: string = "";
  private _tool: string | undefined;

  private _turns: number = 0;
  private _toolUses: number = 0;
  private _compactions: number = 0;

  private _usage: Usage = DefaultUsage;
  private _totalUsage: Usage = DefaultUsage;

  private _createdAt: number = Date.now();

  private _unsubscribe?: () => void;

  constructor(
    readonly id: string,
    readonly groupId: string,
    readonly config: AgentConfig,
    readonly options: AgentOptions,
    readonly onUpdate: (agent: Agent, kind: AgentUpdateKind) => void,
  ) { }

  get status() { return this._status }

  get message() { return this._message }
  get tool() { return this._tool }

  get turns() { return this._turns }
  get toolUses() { return this._toolUses }
  get compactions() { return this._compactions }

  get usage() { return this._usage }
  get totalUsage() { return this._totalUsage }

  get createdAt() { return this._createdAt }

  get source() { return this.config.source }
  get resolvedModel() { return this.options.model ?? this.config.model }
  get resolvedThinking() { return this.options.thinking ?? this.config.thinking }
  get tools() { return this.config.tools }

  get resumable(): boolean {
    if (!this.config.resumable) return false;
    if (this._status.kind !== "done") return true;
    return Boolean(this._status.ran);
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
    const ran = this._status.kind === "running"
      ? { session: this._status.session, startedAt: this._status.startedAt }
      : undefined;
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
        this._tool = event.toolName;
        this._toolUses += 1;
        this.onUpdate(this, "tool");
      }
      else if (event.type === "tool_execution_end") {
        this._tool = undefined;
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
