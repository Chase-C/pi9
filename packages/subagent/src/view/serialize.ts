import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentGroupView, AgentView } from "../domain/agent-view.js";
import { effectiveStatus, isActiveStatusKind } from "./view-helpers.js";

export function serializeGroup(sessions: AgentView[]): AgentGroupView {
  const statusCounts: Record<string, number> = {};
  for (const session of sessions) {
    const status = effectiveStatus(session.status);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return {
    statusCounts,
    sessions,
    isError: sessions.some(session => {
      const status = effectiveStatus(session.status);
      return !isActiveStatusKind(status) && status !== "completed";
    }),
  };
}

export function serializeAgentConfig(config: AgentConfig) {
  return {
    name: config.name,
    description: config.description,
    source: config.source,
    model: config.model,
    thinking: config.thinking,
    tools: config.tools,
    skills: config.skills,
    resumable: config.resumable,
    sourcePath: config.sourcePath,
  };
}

export function listAgentDefinitions(agentRegistry: AgentRegistry) {
  return Array.from(agentRegistry.agents.values()).map(serializeAgentConfig);
}
