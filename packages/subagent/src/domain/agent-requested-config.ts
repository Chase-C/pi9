import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import type { AgentConfig } from "./agent-config.js";
import type { SpawnRequest } from "../schema.js";

/**
 * The task-facing settings selected for one Agent. This is deliberately separate from
 * AgentConfig: a definition is reusable, while a spawn may replace selected settings for its
 * run. Runtime setup consumes this resolved value rather than re-applying that precedence.
 */
export interface AgentRequestedConfig {
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  /** Raw spawn cwd input; runtime resolves it relative to the parent context cwd. */
  readonly cwd?: string;
  readonly resumable: boolean;
}

/** Resolve spawn-over-definition precedence once at the Agent boundary. */
export function resolveRequestedConfig(
  config: AgentConfig,
  spawn: SpawnRequest,
): AgentRequestedConfig {
  const skills = spawn.skills ?? config.skills;
  return {
    model: spawn.model ?? config.model,
    thinking: spawn.thinking ?? config.thinking,
    skills: skills !== undefined ? [...skills] : undefined,
    // Spawn tasks have no tools override; the definition allowlist is canonical here.
    tools: config.tools !== undefined ? [...config.tools] : undefined,
    cwd: spawn.cwd,
    resumable: spawn.resumable ?? config.resumable,
  };
}
