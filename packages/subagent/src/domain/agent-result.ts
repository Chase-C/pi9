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
}

export interface FinalizeRunArgs {
  status: AgentRunStatus;
  output?: string;
  error?: string;
}

export function finalizeRun(agent: Agent, prompt: string, args: FinalizeRunArgs): AgentRunResult {
  if (agent.status.kind === "done") return agent.status.result;

  const resumable = Boolean(agent.config.resumable && hasSessionAttached(agent));
  const result: AgentRunResult = {
    agent: agent.agentName,
    ...(agent.label !== undefined ? { label: agent.label } : {}),
    prompt,
    model: agent.modelOverride ?? agent.config.model,
    resumable,
    status: args.status,
    ...(resumable ? { sessionId: agent.id } : {}),
    ...(args.output !== undefined ? { output: args.output } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
  };
  agent.finalize(result);
  return result;
}

export function completedRun(agent: Agent, prompt: string, output: string): AgentRunResult {
  return finalizeRun(agent, prompt, { status: "completed", output });
}

export function errorRun(agent: Agent, prompt: string, error: string): AgentRunResult {
  return finalizeRun(agent, prompt, { status: "error", error });
}

export function interruptedRun(agent: Agent, prompt: string, error: string): AgentRunResult {
  return finalizeRun(agent, prompt, { status: "interrupted", error });
}

function hasSessionAttached(agent: Agent): boolean {
  if (agent.status.kind === "running") return true;
  if (agent.status.kind === "done") return Boolean(agent.status.ran);
  return false;
}
