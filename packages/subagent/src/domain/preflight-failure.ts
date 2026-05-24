import type { Agent } from "./agent.js";
import type { AgentRunResult } from "./agent-result.js";
import type { AgentSnapshot, AgentViewConfig } from "./agent-snapshot.js";
import type { ResumeRequest, SpawnRequest } from "../schema.js";

export interface PreflightFailure {
  view: AgentSnapshot;
  result: AgentRunResult;
}

interface PreflightFailureMeta {
  groupId: string;
  inputIndex: number;
  createdAt: number;
  task: SpawnRequest | ResumeRequest;
  background: boolean;
}

interface PreflightFailureArgs {
  error: string;
  target?: Agent;
}

export function preflightFailure(
  meta: PreflightFailureMeta,
  args: PreflightFailureArgs,
): PreflightFailure {
  const { groupId, inputIndex, createdAt, task, background } = meta;
  const { error, target } = args;

  const labelField = task.label ? { label: task.label } : {};
  const dispatch = background ? "background" : "foreground";
  const retention = task.resumable ? "persistent" : "transient";
  const anyTask = task as any;
  return {
    view: {
      id: target?.id ?? `${groupId}:resume-${inputIndex}`,
      inputIndex,
      ...labelField,
      prompt: task.prompt,
      createdAt,
      dispatch,
      retention,
      config: preflightTargetConfig(target) ?? {
        name: anyTask.agent,
        source: undefined,
        model: anyTask.model,
        thinking: anyTask.thinking,
        tools: undefined,
        resumable: false,
      },
      status: { kind: "done", outcome: "error", completedAt: createdAt, snippet: error },
      activity: { turns: 0, compactions: 0, toolHistory: [] },
      usage: undefined,
      capabilities: { canResume: false, canClear: false },
    },
    result: {
      agent: task.kind === "spawn" ? task.agent : target?.agentName ?? "(unknown)",
      ...labelField,
      prompt: task.prompt,
      status: "error",
      error,
      model: target ? (target.spawn.model ?? target.config.model) : task.kind === "spawn" ? task.model : undefined,
      resumable: target?.resumable ?? false,
      resumed: task.kind === "resume",
      ...(target ? { sessionId: target.id } : {}),
    },
  };
}

function preflightTargetConfig(target?: Agent): AgentViewConfig | undefined {
  if (!target) return undefined;
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
