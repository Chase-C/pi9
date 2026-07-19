import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentRegistry } from "../domain/agent-registry.js";

export function serializeAgentConfig(config: AgentConfig) {
  return {
    name: config.name,
    description: config.description,
    source: config.source,
    model: config.model,
    thinking: config.thinking,
    tools: config.tools,
    skills: config.skills,
    sourcePath: config.sourcePath,
  };
}

export function listAgentDefinitions(registry: AgentRegistry) {
  return Array.from(registry.agents.values()).map(serializeAgentConfig);
}
