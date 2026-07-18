import { Agent } from "./agent.js";
import type { AgentRunOutcome } from "./agent-lifecycle.js";
import type { AgentRunSnapshot } from "./agent-snapshot.js";
import type { RunId } from "./run-id.js";

export function finalizeRun(agent: Agent, runId: RunId, outcome: AgentRunOutcome): AgentRunSnapshot { return agent.settle(runId, outcome); }
export function completedRun(agent: Agent, runId: RunId, output: string): AgentRunSnapshot { return finalizeRun(agent, runId, { status: "completed", output }); }
export function errorRun(agent: Agent, runId: RunId, error: string): AgentRunSnapshot { return finalizeRun(agent, runId, { status: "error", error }); }
export function interruptedRun(agent: Agent, runId: RunId, error: string): AgentRunSnapshot { return finalizeRun(agent, runId, { status: "interrupted", error }); }
export function skippedRun(agent: Agent, runId: RunId): AgentRunSnapshot { return finalizeRun(agent, runId, { status: "skipped", error: "Agent skipped." }); }
