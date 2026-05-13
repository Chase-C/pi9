import { Agent } from "./agent.js";
import type { AgentRunStatus } from "./agent-view.js";

export interface AgentRunResult {
  agent: string;
  label?: string;
  prompt: string;
  status: AgentRunStatus;
  output?: string;
  error?: string;
  model?: string;
  sessionId?: string;
  resumable: boolean;
  resumed: boolean;
}

export type FinalizeRunArgs =
  | { status: "completed"; output?: string; error?: never; resumed?: boolean }
  | { status: Exclude<AgentRunStatus, "completed">; output?: never; error?: string; resumed?: boolean };

/** Build an AgentRunResult from the agent's current attempt. Pure: does not mutate the agent. */
export function buildAgentResult(agent: Agent, args: FinalizeRunArgs): AgentRunResult {
  const resumable = agent.hasResumableSession();
  const label = agent.label;
  const prompt = agent.requireCurrentAttempt().prompt;
  return {
    agent: agent.agentName,
    ...(label !== undefined ? { label } : {}),
    prompt,
    model: agent.spawn.model ?? agent.config.model,
    resumable,
    resumed: Boolean(args.resumed),
    status: args.status,
    ...(resumable ? { sessionId: agent.id } : {}),
    ...(args.output !== undefined ? { output: args.output } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
  };
}

export function finalizeRun(agent: Agent, args: FinalizeRunArgs): AgentRunResult {
  if (agent.status.kind === "done" && !agent.current) return agent.status.result;
  const result = buildAgentResult(agent, args);
  agent.settle(result);
  return result;
}

export function completedRun(agent: Agent, output: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, { status: "completed", output, resumed });
}

export function errorRun(agent: Agent, error: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, { status: "error", error, resumed });
}

export function interruptedRun(agent: Agent, error: string, resumed = false): AgentRunResult {
  return finalizeRun(agent, { status: "interrupted", error, resumed });
}

export function skippedRun(agent: Agent, resumed = false): AgentRunResult {
  return finalizeRun(agent, { status: "skipped", error: "Agent skipped.", resumed });
}
