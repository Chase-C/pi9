import type { AgentConfig } from "./agent-config.js";
import type { AgentRequestedConfig } from "./agent-requested-config.js";
import type { AgentSnapshot } from "./agent-snapshot.js";
import type { ResumeRequest, SpawnRequest } from "../schema.js";

interface PreflightFailureMeta {
  groupId: string;
  inputIndex: number;
  task: SpawnRequest | ResumeRequest;
  background: boolean;
}

interface PreflightFailureTarget {
  readonly id: string;
  readonly agentName: string;
  readonly config: AgentConfig;
  readonly requestedConfig: AgentRequestedConfig;
  readonly spawn: SpawnRequest;
  readonly shouldRetainConversation: boolean;
}

interface PreflightFailureArgs {
  error: string;
  target?: PreflightFailureTarget;
}

/**
 * Build the terminal row for a task rejected before it gets an Agent attempt. This deliberately
 * projects the same DTO shape as Agent.snapshot() without constructing a throwaway Agent: failed
 * tasks never enter the session catalog and therefore do not need domain lifecycle state.
 *
 * The id reuses the live target's id when resuming a known session, else the
 * `${groupId}:resume-${inputIndex}` scheme so run-group ordering by `inputIndex` is preserved.
 */
export function preflightFailure(
  meta: PreflightFailureMeta,
  args: PreflightFailureArgs,
): AgentSnapshot {
  const { groupId, inputIndex, task, background } = meta;
  const { error, target } = args;
  const id = target?.id ?? `${groupId}:resume-${inputIndex}`;
  const label = task.label !== undefined ? task.label : target?.spawn.label;
  const name = target?.agentName ?? (task.kind === "spawn" ? task.agent : "(unknown)");
  const model = target?.requestedConfig.model ?? (task.kind === "spawn" ? task.model : undefined);
  const thinking = target?.requestedConfig.thinking ?? (task.kind === "spawn" ? task.thinking : undefined);
  const config = target?.config;
  const description = target ? target.config.description : "";
  const skills = target?.requestedConfig.skills ?? (task.kind === "spawn" ? task.skills : undefined);
  const createdAt = Date.now();
  const completedAt = Date.now();

  return {
    id,
    inputIndex,
    ...(label !== undefined ? { label } : {}),
    prompt: task.prompt,
    createdAt,
    dispatch: background ? "background" : "foreground",
    // Preflight rows are per-run and never retained, even under a background batch.
    retention: "transient",
    config: {
      name,
      description,
      source: config?.source,
      sourcePath: config?.sourcePath,
      model,
      thinking,
      tools: target?.requestedConfig.tools,
      ...(skills !== undefined ? { skills } : {}),
      resumable: target?.shouldRetainConversation ?? false,
    },
    status: {
      kind: "done",
      outcome: "error",
      completedAt,
      resumed: task.kind === "resume",
      error,
    },
    activity: { turns: 0, compactions: 0, toolHistory: [] },
    usage: undefined,
    capabilities: {
      canResume: false,
      canRemove: false,
      canClear: false,
    },
  };
}
