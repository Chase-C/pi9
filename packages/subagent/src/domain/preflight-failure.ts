import type { AgentConfig } from "./agent-config.js";
import type { AgentDispatch } from "./agent-lifecycle.js";
import type { AgentRequestedConfig } from "./agent-requested-config.js";
import type { AgentSnapshot } from "./agent-snapshot.js";
import type { ResumeRequest, SpawnRequest } from "../schema.js";

interface PreflightFailureMeta {
  groupId: string;
  inputIndex: number;
  task: SpawnRequest | ResumeRequest;
  dispatch: AgentDispatch;
}
interface PreflightFailureTarget {
  readonly id: string;
  readonly agentName: string;
  readonly label?: string;
  readonly config: AgentConfig;
  readonly requestedConfig: AgentRequestedConfig;
}
interface PreflightFailureArgs {
  error: string;
  target?: PreflightFailureTarget;
}

/** Build an uncataloged terminal row for a task rejected before an attempt is created. */
export function preflightFailure(
  meta: PreflightFailureMeta,
  args: PreflightFailureArgs,
): AgentSnapshot {
  const { groupId, inputIndex, task, dispatch } = meta;
  const { error, target } = args;
  const id = target?.id ?? `${groupId}:resume-${inputIndex}`;
  const label =
    target?.label ?? (task.kind === "spawn" ? task.label : undefined);
  const name =
    target?.agentName ?? (task.kind === "spawn" ? task.agent : "(unknown)");
  const model =
    target?.requestedConfig.model ??
    (task.kind === "spawn" ? task.model : undefined);
  const thinking =
    target?.requestedConfig.thinking ??
    (task.kind === "spawn" ? task.thinking : undefined);
  const skills =
    target?.requestedConfig.skills ??
    (task.kind === "spawn" ? task.skills : undefined);
  const policy =
    target?.requestedConfig.conversationPolicy ??
    (task.kind === "spawn" && task.retainConversation ? "retain" : "release");
  const createdAt = Date.now();
  return {
    id,
    inputIndex,
    ...(label !== undefined ? { label } : {}),
    prompt: task.prompt,
    createdAt,
    attempt: { kind: task.kind, dispatch },
    conversation: { policy, available: false },
    retention: { catalog: "transient", reasons: [] },
    config: {
      name,
      description: target?.config.description ?? "",
      source: target?.config.source,
      sourcePath: target?.config.sourcePath,
      model,
      thinking,
      tools: target?.requestedConfig.tools,
      ...(skills !== undefined ? { skills } : {}),
    },
    status: { kind: "done", outcome: "error", completedAt: Date.now(), error },
    activity: { turns: 0, compactions: 0, toolHistory: [] },
    usage: undefined,
    capabilities: { canResume: false, canRemove: false },
  };
}
