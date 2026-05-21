import type { Agent } from "../domain/agent.js";
import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentRegistry } from "../domain/agent-registry.js";
import {
  preflightResumeFailure,
  preflightSpawnFailure,
  type PreflightFailure,
} from "../domain/preflight-failure.js";
import type { ResumeRequest, SpawnRequest } from "../schema.js";

export type SpawnPreflight =
  | { kind: "failure"; failure: PreflightFailure }
  | { kind: "ok"; config: AgentConfig };

export type ResumePreflight =
  | { kind: "failure"; failure: PreflightFailure }
  | { kind: "ok"; target: Agent };

interface SpawnArgs {
  task: SpawnRequest;
  groupId: string;
  inputIndex: number;
  createdAt: number;
  registry: AgentRegistry;
  background?: boolean;
}

export function resolveSpawn(args: SpawnArgs): SpawnPreflight {
  const { task, groupId, inputIndex, createdAt, registry } = args;
  const config = registry.agents.get(task.agent);
  if (config) return { kind: "ok", config };
  const available = Array.from(registry.agents.values())
    .map(agent => `${agent.name} (${agent.source})`)
    .join("\n");
  const error = `Unknown agent: ${task.agent}. Available agents:\n${available}`;
  return {
    kind: "failure",
    failure: preflightSpawnFailure({
      groupId,
      inputIndex,
      createdAt,
      task,
      error,
      ...(args.background ? { dispatch: "background" as const } : {}),
    }),
  };
}

interface ResumeArgs {
  task: ResumeRequest;
  groupId: string;
  inputIndex: number;
  createdAt: number;
  findResumable: (id: string) => Agent | undefined;
  background?: boolean;
}

export function resolveResume(args: ResumeArgs): ResumePreflight {
  const { task, groupId, inputIndex, createdAt, findResumable } = args;
  const target = findResumable(task.sessionId);
  const error = !target
    ? `Unknown resumable subagent session: ${task.sessionId}`
    : target.hasCurrentAttempt
      ? `Cannot resume subagent session ${task.sessionId}: it is already resuming.`
      : !target.canResume
        ? `Cannot resume subagent session ${task.sessionId} while it is ${target.status.kind === "done" ? target.status.result.status : target.status.kind}.`
        : undefined;
  if (target && !error) return { kind: "ok", target };
  return {
    kind: "failure",
    failure: preflightResumeFailure({
      groupId,
      inputIndex,
      createdAt,
      task,
      target,
      error: error!,
      ...(args.background ? { dispatch: "background" as const } : {}),
    }),
  };
}
