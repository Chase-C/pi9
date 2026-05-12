import { Usage } from "@mariozechner/pi-ai";
import { AgentSession } from "@mariozechner/pi-coding-agent";

import { AgentConfig } from "./agent-config.js";
import type { AgentInvocation, AgentSpawn } from "./agent-invocation.js";
import type { AgentRunResult, FinalizeRunArgs } from "./agent-result.js";
import type { AgentToolUse, AgentUpdateKind, AgentView, AgentViewStatus } from "./agent-view.js";
import { compact, compactMultiline, getSubagentDisplaySettings } from "../view/view-helpers.js";

const DefaultUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export type AgentStatus =
  | { kind: "queued" }
  | { kind: "running"; session: AgentSession; startedAt: number }
  | { kind: "done"; result: AgentRunResult; ran?: { session: AgentSession; startedAt: number }; completedAt: number }
  | { kind: "resumeFailed"; result: AgentRunResult; completedAt: number; ran: { session: AgentSession; startedAt: number } };

export class Agent {

  readonly agentName: string;
  readonly createdAt = Date.now();

  private _status: AgentStatus = { kind: "queued" };
  private _label: string | undefined;
  private _resumableOverride: boolean | undefined;
  private _prompt: string | undefined;
  private _message: string = "";
  private _turns: number = 0;
  private _toolHistory = new Array<AgentToolUse>();
  private _nextSyntheticToolId = 0;
  private _compactions: number = 0;
  private _totalUsage: Usage = DefaultUsage;
  private _unsubscribe?: () => void;

  constructor(
    readonly id: string,
    readonly config: AgentConfig,
    readonly spawn: AgentSpawn,
    invocation: AgentInvocation,
    private readonly onUpdate: (agent: Agent, kind: AgentUpdateKind) => void,
  ) {
    this.agentName = spawn.agent;
    this.apply(invocation);
  }

  get label() { return this._label }
  get resumableOverride() { return this._resumableOverride }
  get status() { return this._status }
  get message() { return this._message }

  /** Apply per-invocation state. Returns an undo to roll back if the run aborts pre-attach. */
  apply(invocation: AgentInvocation): () => void {
    const prevLabel = this._label;
    const prevResumable = this._resumableOverride;
    const prevPrompt = this._prompt;
    this._prompt = invocation.prompt;
    if (invocation.label !== undefined) this._label = invocation.label;
    if (invocation.resumable !== undefined) this._resumableOverride = invocation.resumable;
    this.onUpdate(this, "status");
    return () => {
      this._label = prevLabel;
      this._resumableOverride = prevResumable;
      this._prompt = prevPrompt;
      this.onUpdate(this, "status");
    };
  }

  get resumable(): boolean {
    const base = this._resumableOverride ?? this.config.resumable;
    if (!base) return false;
    if (this._status.kind === "done") return Boolean(this._status.ran);
    return true;
  }

  buildResult(prompt: string, args: FinalizeRunArgs): AgentRunResult {
    const resumable = this._hasResumableSession();
    return {
      agent: this.agentName,
      ...(this._label !== undefined ? { label: this._label } : {}),
      prompt,
      model: this.spawn.model ?? this.config.model,
      resumable,
      resumed: Boolean(args.resumed),
      status: args.status,
      ...(resumable ? { sessionId: this.id } : {}),
      ...(args.output !== undefined ? { output: args.output } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    };
  }

  private _hasResumableSession(): boolean {
    if (!this.resumable) return false;
    if (this._status.kind === "running") return true;
    if (this._status.kind === "done") return Boolean(this._status.ran);
    if (this._status.kind === "resumeFailed") return true;
    return false;
  }

  toView(inputIndex?: number): AgentView {
    return {
      id: this.id,
      ...(inputIndex !== undefined ? { inputIndex } : {}),
      ...(this._label !== undefined ? { label: this._label } : {}),
      ...(this._prompt !== undefined ? { prompt: this._prompt } : {}),
      createdAt: this.createdAt,
      config: {
        name: this.agentName,
        description: this.config.description,
        source: this.config.source,
        sourcePath: this.config.sourcePath,
        model: this.spawn.model ?? this.config.model,
        thinking: this.spawn.thinking ?? this.config.thinking,
        tools: this.config.tools,
        ...(this.config.skills !== undefined ? { skills: this.config.skills } : {}),
        resumable: this.resumable,
      },
      status: this._viewStatus(),
      activity: {
        messageSnippet: this._message ? compact(this._message, getSubagentDisplaySettings().messageSnippetLength) : undefined,
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
      this._status.kind === "resumeFailed" ||
      (this._status.kind === "done" && this._status.result.status === "completed");
    if (!canAttach) {
      throw new Error(`Cannot attach a session to an agent that is ${this._describe()}.`);
    }
    this._subscribe(session);
    this._status = { kind: "running", session, startedAt: Date.now() };
    this.onUpdate(this, "status");
  }

  markResumeFailed(result: AgentRunResult) {
    const ran = this._status.kind === "done" ? this._status.ran
      : this._status.kind === "resumeFailed" ? this._status.ran
      : undefined;
    if (!ran) {
      throw new Error(`Cannot mark resume failed on an agent that is ${this._describe()}.`);
    }
    this._status = { kind: "resumeFailed", result, completedAt: Date.now(), ran };
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
    const startedAt = this._status.kind === "done" ? this._status.ran?.startedAt : undefined;
    return {
      kind: "done",
      outcome: result.status,
      completedAt: this._status.completedAt,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(rawSnippet ? { snippet: compactMultiline(rawSnippet, getSubagentDisplaySettings().outputSnippetLength, getSubagentDisplaySettings().outputSnippetMaxLines) } : {}),
    };
  }

  private _describe(): string {
    if (this._status.kind === "done") return `done (${this._status.result.status})`;
    if (this._status.kind === "resumeFailed") return `resume-failed (${this._status.result.status})`;
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
