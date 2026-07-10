import { Agent } from "./agent.js";
import type { AgentConfig } from "./agent-config.js";
import type { AgentRetention, AgentSnapshot } from "./agent-snapshot.js";
import type { ResumeRequest, SpawnRequest } from "../schema.js";

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

const NOOP_LISTENER = () => {};

/**
 * A failed preflight (unknown agent, bad or blocked resume) is represented as a synthetic
 * terminal snapshot in `error` state, built through the one snapshot factory on a throwaway
 * `Agent`. The throwaway never enters the catalog, so its placeholder config can't leak into
 * agent listing or discovery. The failed row and the result both derive from this snapshot.
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
  const { config, spawn } = preflightAgentInputs(task, target);
  const agent = new Agent(id, config, spawn, NOOP_LISTENER, { background });
  agent.settle({ status: "error", error, resumed: task.kind === "resume" });

  // Preflight rows are per-run and never retained, even under a background batch; the factory's
  // background-implies-persistent rule doesn't apply here.
  const retention: AgentRetention = "transient";
  const snapshot: AgentSnapshot = { ...agent.snapshot({ inputIndex }), retention };
  // A throwaway Agent has no retained session, so its `resumable` is always false; reflect the
  // live target's resumability instead so the result/row match the session being resumed.
  if (!target) return { ...snapshot, config: { ...snapshot.config, source: undefined } };
  return { ...snapshot, config: { ...snapshot.config, resumable: target.resumable } };
}

/** Config + spawn for the throwaway Agent: the live target's when known, else a placeholder. */
function preflightAgentInputs(
  task: SpawnRequest | ResumeRequest,
  target?: Agent,
): { config: AgentConfig; spawn: SpawnRequest } {
  if (target) {
    return {
      config: target.config,
      spawn: { ...target.spawn, prompt: task.prompt, ...(task.label !== undefined ? { label: task.label } : {}) },
    };
  }

  const name = task.kind === "spawn" ? task.agent : "(unknown)";
  const model = task.kind === "spawn" ? task.model : undefined;
  const thinking = task.kind === "spawn" ? task.thinking : undefined;
  const config: AgentConfig = {
    name,
    description: "",
    systemPrompt: "",
    source: "project",
    resumable: false,
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
  const spawn: SpawnRequest = {
    kind: "spawn",
    agent: name,
    prompt: task.prompt,
    ...(task.label !== undefined ? { label: task.label } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
  return { config, spawn };
}
