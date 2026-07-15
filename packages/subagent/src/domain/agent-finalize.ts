import { Agent } from "./agent.js";
import type { AgentRunOutcome } from "./agent-lifecycle.js";
import type { AgentSnapshot } from "./agent-snapshot.js";

/**
 * Settle the agent's current attempt and return its terminal snapshot. Idempotent: once the
 * agent is done with no in-flight attempt, the existing terminal snapshot is returned unchanged.
 */
export function finalizeRun(agent: Agent, outcome: AgentRunOutcome): AgentSnapshot {
  if (agent.status.kind === "done" && !agent.hasCurrentAttempt) return agent.snapshot();
  return agent.settle(outcome);
}

export function completedRun(agent: Agent, output: string): AgentSnapshot {
  return finalizeRun(agent, { status: "completed", output });
}

export function errorRun(agent: Agent, error: string): AgentSnapshot {
  return finalizeRun(agent, { status: "error", error });
}

export function interruptedRun(agent: Agent, error: string): AgentSnapshot {
  return finalizeRun(agent, { status: "interrupted", error });
}

export function skippedRun(agent: Agent): AgentSnapshot {
  return finalizeRun(agent, { status: "skipped", error: "Agent skipped." });
}
