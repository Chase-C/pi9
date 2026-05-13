import type { Agent } from "./agent.js";
import type { AgentRunResult } from "./agent-result.js";
import type { AgentView } from "./agent-view.js";
import type { ResumeRequest, SpawnRequest } from "../schema.js";

export interface PreflightFailure {
  view: AgentView;
  result: AgentRunResult;
}

interface PreflightSpawnFailureArgs {
  groupId: string;
  inputIndex: number;
  createdAt: number;
  task: SpawnRequest;
  error: string;
}

export function preflightSpawnFailure(args: PreflightSpawnFailureArgs): PreflightFailure {
  const { groupId, inputIndex, createdAt, task, error } = args;
  const labelField = task.label !== undefined ? { label: task.label } : {};
  return {
    view: {
      id: `${groupId}:task-${inputIndex}`,
      inputIndex,
      ...labelField,
      prompt: task.prompt,
      createdAt,
      kind: "retained",
      config: {
        name: task.agent,
        source: undefined,
        model: task.model,
        thinking: task.thinking,
        tools: undefined,
        resumable: false,
      },
      status: { kind: "done", outcome: "error", completedAt: createdAt, snippet: error },
      activity: { turns: 0, compactions: 0, toolHistory: [] },
      usage: undefined,
    },
    result: {
      agent: task.agent,
      ...labelField,
      prompt: task.prompt,
      status: "error",
      error,
      model: task.model,
      resumable: false,
      resumed: false,
    },
  };
}

interface PreflightResumeFailureArgs {
  groupId: string;
  inputIndex: number;
  createdAt: number;
  task: ResumeRequest;
  target: Agent | undefined;
  error: string;
}

export function preflightResumeFailure(args: PreflightResumeFailureArgs): PreflightFailure {
  const { groupId, inputIndex, createdAt, task, target, error } = args;
  const label = task.label ?? target?.label;
  const labelField = label !== undefined ? { label } : {};
  const targetConfig = target?.toView().config;
  return {
    view: {
      id: target?.id ?? `${groupId}:resume-${inputIndex}`,
      inputIndex,
      ...labelField,
      prompt: task.prompt,
      createdAt,
      kind: target ? target.toView().kind : "retained",
      config: targetConfig ?? {
        name: "(unknown)",
        source: undefined,
        model: undefined,
        thinking: undefined,
        tools: undefined,
        resumable: false,
      },
      status: { kind: "done", outcome: "error", completedAt: createdAt, snippet: error },
      activity: { turns: 0, compactions: 0, toolHistory: [] },
      usage: undefined,
    },
    result: {
      agent: target?.agentName ?? "(unknown)",
      ...labelField,
      prompt: task.prompt,
      status: "error",
      error,
      model: target ? (target.spawn.model ?? target.config.model) : undefined,
      resumable: target?.resumable ?? false,
      resumed: true,
      ...(target ? { sessionId: target.id } : {}),
    },
  };
}
