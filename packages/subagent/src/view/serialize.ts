import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentRunSnapshot, AgentSnapshot } from "../domain/agent-snapshot.js";
import { effectiveStatus, isActiveStatusKind } from "../domain/agent-decisions.js";
import type { RunStatus } from "../schema.js";

export function serializeAgentConfig(config: AgentConfig) {
  return { name: config.name, description: config.description, source: config.source, model: config.model,
    thinking: config.thinking, tools: config.tools, skills: config.skills, sourcePath: config.sourcePath };
}
export function listAgentDefinitions(registry: AgentRegistry) { return Array.from(registry.agents.values()).map(serializeAgentConfig); }
export function listAgentDefinitionsForModel(registry: AgentRegistry) { return listAgentDefinitions(registry); }

export interface ModelInventoryEntry {
  runId: string;
  conversationId: string;
  status: RunStatus;
  agent: string;
  label?: string;
  isLatestRun: boolean;
  acknowledged: boolean;
  canJoin: boolean;
  canResume: boolean;
  canRemove: boolean;
}
export interface ModelInventory { view: "inventory"; runs: ModelInventoryEntry[]; filter?: { status?: RunStatus[] } }

export function serializeInventoryForModel(conversations: AgentSnapshot[], filter?: { status?: RunStatus[] }): ModelInventory {
  const runs = conversations.flatMap(conversation => conversation.runs.map((run, index) => serializeRun(conversation, run, index === conversation.runs.length - 1)))
    .filter(run => !filter?.status || filter.status.includes(run.status));
  return { view: "inventory", runs, ...(filter ? { filter } : {}) };
}

function serializeRun(conversation: AgentSnapshot, run: AgentRunSnapshot, isLatestRun: boolean): ModelInventoryEntry {
  const status = effectiveStatus(run.status) as RunStatus;
  return {
    runId: run.runId,
    conversationId: conversation.conversationId,
    status,
    agent: conversation.config.name,
    ...(conversation.label !== undefined ? { label: conversation.label } : {}),
    isLatestRun,
    acknowledged: run.acknowledged,
    canJoin: isActiveStatusKind(status) || status === "completed" || status === "aborted",
    canResume: isLatestRun && conversation.capabilities.canResume,
    canRemove: conversation.capabilities.canRemove,
  };
}
