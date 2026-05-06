import { Usage } from "@mariozechner/pi-ai";
import { AgentSession } from "@mariozechner/pi-coding-agent";

import { AgentConfig } from "./agent-config.js";
import { AgentOptions } from "./agent-manager.js";

const DefaultUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export type AgentStatus =
  | { kind: "queued" }
  | { kind: "running", session: AgentSession, startedAt: number }
  | { kind: "completed", session: AgentSession, startedAt: number, completedAt: number, response: string }
  | { kind: "aborted", session?: AgentSession, startedAt?: number, abortedAt: number }
  | { kind: "error", session: AgentSession, startedAt: number, errorAt: number, error: string };

export type AgentUpdateKind = "status" | "message" | "tool" | "turn" | "usage" | "compaction";

export class Agent {

  private _status: AgentStatus = { kind: "queued" };

  private _run: Promise<string>;
  private _resolveRun!: (value: string) => void;
  private _rejectRun!: (reason: any) => void;

  private _message: string = "";
  private _tool: string | undefined;

  private _turns: number = 0;
  private _toolUses: number = 0;
  private _compactions: number = 0;

  private _usage: Usage = DefaultUsage;
  private _totalUsage: Usage = DefaultUsage;

  private _createdAt: number = Date.now();

  constructor(
    readonly id: string,
    readonly groupId: string,
    readonly config: AgentConfig,
    readonly options: AgentOptions,
    readonly onUpdate: (agent: Agent, kind: AgentUpdateKind) => void,
  ) {
    this._run = new Promise<string>((resolve, reject) => {
      this._resolveRun = resolve;
      this._rejectRun = reject;
    });
  }

  get run() { return this._run }
  get status() { return this._status }

  get message() { return this._message }
  get tool() { return this._tool }

  get turns() { return this._turns }
  get toolUses() { return this._toolUses }
  get compactions() { return this._compactions }

  get usage() { return this._usage }
  get totalUsage() { return this._totalUsage }

  get createdAt() { return this._createdAt }

  trackRun(run: Promise<string>) {
    run.then(
      result => this._resolveRun(result),
      err => this._rejectRun(err),
    )
  }

  abort() {
    if (this._status.kind !== "running") {
      throw new Error(`Cannot abort an agent that ${this._status.kind === "queued" ? "has not started" : "is not running"}.`);
    }

    this._status = { kind: "aborted", session: this._status.session, startedAt: this._status.startedAt, abortedAt: Date.now() };
    this.onUpdate(this, "status");
  }

  cancelQueued() {
    if (this._status.kind !== "queued") {
      throw new Error(`Cannot cancel an agent that is ${this._status.kind}.`);
    }

    this._status = { kind: "aborted", abortedAt: Date.now() };
    this.onUpdate(this, "status");
  }

  complete(response: string) {
    if (this._status.kind !== "running") {
      throw new Error(`Cannot complete an agent that ${this._status.kind === "queued" ? "has not started" : "is not running"}.`);
    }

    this._status = { kind: "completed", session: this._status.session, startedAt: this._status.startedAt, completedAt: Date.now(), response: response };
    this.onUpdate(this, "status");
  }

  error(error: string) {
    if (this._status.kind !== "running") {
      throw new Error(`Cannot error an agent that ${this._status.kind === "queued" ? "has not started" : "is not running"}.`);
    }

    this._status = { kind: "error", session: this._status.session, startedAt: this._status.startedAt, errorAt: Date.now(), error };
    this.onUpdate(this, "status");
  }

  start(session: AgentSession) {
    if (this._status.kind !== "queued") {
      throw new Error(`Cannot start an agent that is already ${this._status.kind}.`);
    }

    this._status = { kind: "running", session: session, startedAt: Date.now() };
    this.onUpdate(this, "status");
  }

  resume(session: AgentSession) {
    if (this._status.kind !== "completed") {
      throw new Error(`Cannot resume an agent that is ${this._status.kind}.`);
    }

    this._status = { kind: "running", session: session, startedAt: Date.now() };
    this.onUpdate(this, "status");
  }

  compacted() {
    this._compactions += 1;
    this.onUpdate(this, "compaction");
  }

  messageUpdated(message: string) {
    this._message = message;
    this.onUpdate(this, "message");
  }

  toolStarted(tool: string) {
    this._tool = tool;
    this._toolUses += 1;
    this.onUpdate(this, "tool");
  }

  toolEnded() {
    this._tool = undefined;
    this.onUpdate(this, "tool");
  }

  turnEnded() {
    this._turns += 1;
    this.onUpdate(this, "turn");
  }

  usageUpdated(usage: Usage) {
    this._usage = usage;
    this._totalUsage = CombineUsage(this._totalUsage, usage);
    this.onUpdate(this, "usage");
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
