import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { AgentRunResult } from "./agent-result.js";

export type AttemptKind = "spawn" | "resume";

export type AttemptState =
  | { kind: "queued" }
  | { kind: "running"; session: AgentSession; startedAt: number }
  | { kind: "done"; result: AgentRunResult; startedAt?: number; completedAt: number };

/**
 * A single invocation against an Agent. Each attempt is created with immutable
 * inputs (prompt, label override, resumable override) and progresses through
 * queued → running → done. Pre-attach failure leaves the attempt in `queued`
 * before settle; the prior attempt's retained session is untouched.
 */
export class Attempt {

  readonly createdAt = Date.now();
  state: AttemptState = { kind: "queued" };

  constructor(
    readonly kind: AttemptKind,
    readonly prompt: string,
    readonly label: string | undefined,
    readonly resumableOverride: boolean | undefined,
  ) {}

  attach(session: AgentSession): void {
    if (this.state.kind !== "queued") {
      throw new Error(`Cannot attach a session to an attempt that is ${this.state.kind}.`);
    }
    this.state = { kind: "running", session, startedAt: Date.now() };
  }

  settle(result: AgentRunResult): void {
    if (this.state.kind === "done") return;
    const startedAt = this.state.kind === "running" ? this.state.startedAt : undefined;
    this.state = { kind: "done", result, startedAt, completedAt: Date.now() };
  }

  get session(): AgentSession | undefined {
    return this.state.kind === "running" ? this.state.session : undefined;
  }

  get result(): AgentRunResult | undefined {
    return this.state.kind === "done" ? this.state.result : undefined;
  }
}
