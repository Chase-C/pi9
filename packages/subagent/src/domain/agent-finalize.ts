import { Agent } from "./agent.js";
import type { AgentSnapshot } from "./agent-snapshot.js";
import { toOutcome, type FinalizeRunArgs } from "./agent-result.js";

/**
 * Settle the agent's current attempt and return its terminal snapshot. Idempotent: once the
 * agent is done with no in-flight attempt, the existing terminal snapshot is returned unchanged.
 */
export function finalizeRun(agent: Agent, args: FinalizeRunArgs): AgentSnapshot {
  if (agent.status.kind === "done" && !agent.hasCurrentAttempt) return agent.snapshot();
  return agent.settle(toOutcome(args));
}

export function completedRun(agent: Agent, output: string, resumed = false): AgentSnapshot {
  return finalizeRun(agent, { status: "completed", output, resumed });
}

export function errorRun(agent: Agent, error: string, resumed = false): AgentSnapshot {
  return finalizeRun(agent, { status: "error", error, resumed });
}

export function interruptedRun(agent: Agent, error: string, resumed = false): AgentSnapshot {
  return finalizeRun(agent, { status: "interrupted", error, resumed });
}

export function skippedRun(agent: Agent, resumed = false): AgentSnapshot {
  return finalizeRun(agent, { status: "skipped", error: "Agent skipped.", resumed });
}
