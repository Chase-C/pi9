import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import type { AgentConfig } from "./agent-config.js";
import type { SpawnRequest } from "../schema.js";
export interface AgentRequestedConfig {
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly cwd?: string;
}

/** Resolve spawn-over-definition precedence. */
export function resolveRequestedConfig(
  config: AgentConfig,
  spawn: SpawnRequest,
): AgentRequestedConfig {
  const skills = spawn.skills ?? config.skills;
  return {
    model: spawn.model ?? config.model,
    thinking: spawn.thinking ?? config.thinking,
    skills: skills !== undefined ? [...skills] : undefined,
    tools: config.tools !== undefined ? [...config.tools] : undefined,
    cwd: spawn.cwd,
  };
}
