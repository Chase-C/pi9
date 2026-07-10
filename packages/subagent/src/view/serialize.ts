import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentGroupView, AgentSnapshot } from "../domain/agent-snapshot.js";
import { effectiveStatus, isActiveStatusKind } from "../domain/agent-decisions.js";

export function serializeGroup(sessions: AgentSnapshot[]): AgentGroupView {
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

export function listAgentDefinitionsForModel(agentRegistry: AgentRegistry) {
  return listAgentDefinitions(agentRegistry).map(({ resumable, ...agent }) => ({
    ...agent,
    defaultResumable: resumable,
  }));
}

export function serializeInventoryForModel(sessions: AgentSnapshot[], filter?: { status?: string[] }) {
  return {
    view: "inventory" as const,
    sessions: sessions.map(serializeSessionForModel),
    ...(filter ? { filter } : {}),
  };
}

function serializeSessionForModel(session: AgentSnapshot) {
  const { capabilities, ...snapshot } = session;
  return {
    ...snapshot,
    status: serializeStatusForModel(session.status),
    ...(session.previousRuns
      ? {
          previousRuns: session.previousRuns.map(run => ({
            ...run,
            status: serializeStatusForModel(run.status),
          })),
        }
      : {}),
    capabilities: {
      canResume: capabilities.canResume,
      canRemove: true,
    },
  };
}

function serializeStatusForModel(status: AgentSnapshot["status"]) {
  if (status.kind !== "done") return status;
  const { kind: _kind, outcome, ...terminal } = status;
  return { ...terminal, kind: outcome };
}
