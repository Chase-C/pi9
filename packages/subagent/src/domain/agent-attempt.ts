import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentActivity, type AgentActivityListener } from "./agent-activity.js";
import type { AgentRunOutcome, RunKind } from "./agent-lifecycle.js";
import type { RunId } from "./run-id.js";

export type AttemptState =
  | { readonly kind: "queued" }
  | { readonly kind: "running"; readonly session: AgentSession; readonly startedAt: number }
  | { readonly kind: "done"; readonly result: AgentRunOutcome; readonly startedAt?: number; readonly completedAt: number };

/** Mutable execution holder. Once terminal, its state and projected history entry never change. */
export class Attempt {
  readonly createdAt = Date.now();
  readonly activity: AgentActivity;
  state: AttemptState = { kind: "queued" };
  observerCount = 0;
  acknowledged = false;
  constructor(readonly runId: RunId, readonly kind: RunKind, readonly prompt: string, onChange: AgentActivityListener) {
    this.activity = new AgentActivity(onChange);
  }

  attach(session: AgentSession): void {
    if (this.state.kind !== "queued") throw new Error(`Cannot attach a session to a run that is ${this.state.kind}.`);
    this.state = { kind: "running", session, startedAt: Date.now() };
  }

  settle(result: AgentRunOutcome): boolean {
    if (this.state.kind === "done") return false;
    const startedAt = this.state.kind === "running" ? this.state.startedAt : undefined;
    this.state = Object.freeze({ kind: "done", result: Object.freeze({ ...result }), startedAt, completedAt: Date.now() });
    return true;
  }
}
