import type { Agent } from "./agent.js";
import type { AgentRunResult } from "./agent-result.js";
import type { AgentDispatch, AgentRetention, AgentView, AgentViewConfig } from "./agent-view.js";
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
  dispatch?: AgentDispatch;
  retention?: AgentRetention;
}

export function preflightSpawnFailure(args: PreflightSpawnFailureArgs): PreflightFailure {
  const { groupId, inputIndex, createdAt, task, error } = args;
  const dispatch = args.dispatch ?? "foreground";
  const retention = args.retention ?? "transient";
  const labelField = task.label !== undefined ? { label: task.label } : {};
  return {
    view: {
      id: `${groupId}:task-${inputIndex}`,
      inputIndex,
      ...labelField,
      prompt: task.prompt,
      createdAt,
      dispatch,
      retention,
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
      capabilities: { canResume: false, canClear: false },
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
  dispatch?: AgentDispatch;
  retention?: AgentRetention;
}

export function preflightResumeFailure(args: PreflightResumeFailureArgs): PreflightFailure {
  const { groupId, inputIndex, createdAt, task, target, error } = args;
  const label = task.label ?? target?.label;
  const labelField = label !== undefined ? { label } : {};
  const dispatch = args.dispatch ?? (target?.background ? "background" : "foreground");
  const retention = args.retention ?? "transient";
  const targetConfig = target ? preflightTargetConfig(target) : undefined;
  return {
    view: {
      id: target?.id ?? `${groupId}:resume-${inputIndex}`,
      inputIndex,
      ...labelField,
      prompt: task.prompt,
      createdAt,
      dispatch,
      retention,
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
      capabilities: { canResume: false, canClear: false },
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

function preflightTargetConfig(target: Agent): AgentViewConfig {
  return {
    name: target.agentName,
    description: target.config.description,
    source: target.config.source,
    sourcePath: target.config.sourcePath,
    model: target.spawn.model ?? target.config.model,
    thinking: target.spawn.thinking ?? target.config.thinking,
    tools: target.config.tools,
    ...(target.config.skills !== undefined ? { skills: target.config.skills } : {}),
    resumable: target.resumable,
  };
}
