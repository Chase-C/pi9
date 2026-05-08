import type { Usage } from "@mariozechner/pi-ai";

import type { AgentStatus, AgentView } from "./agent.js";
import type { AgentConfig } from "./agent-config.js";
import type { AgentRegistry } from "./agent-registry.js";

export const PROMPT_PREVIEW_LENGTH = 120;
export const MESSAGE_SNIPPET_LENGTH = 200;
export const OUTPUT_SNIPPET_LENGTH = 200;

export interface AgentRow {
  id: string;
  groupId: string;
  agent: string;
  status: string;
  resumable: boolean;
  promptPreview: string;
  messageSnippet?: string;
  outputSnippet?: string;
  errorSnippet?: string;
  activeTool?: string;
  turns: number;
  toolUses: number;
  compactions: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  source?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  usage?: Usage;
  inputIndex?: number;
}

export interface AgentRowGroup {
  id: string;
  createdAt: number;
  statusCounts: Record<string, number>;
  sessions: AgentRow[];
  isError: boolean;
}

export function serializeAgent(entry: AgentView, inputIndex?: number): AgentRow {
  const status = entry.status;
  return {
    id: entry.id,
    groupId: entry.groupId,
    agent: entry.options.agent,
    status: effectiveStatus(status),
    resumable: entry.resumable,
    promptPreview: compact(entry.options.prompt, PROMPT_PREVIEW_LENGTH),
    messageSnippet: entry.message ? compact(entry.message, MESSAGE_SNIPPET_LENGTH) : undefined,
    activeTool: entry.tool,
    turns: entry.turns,
    toolUses: entry.toolUses,
    compactions: entry.compactions,
    createdAt: entry.createdAt,
    startedAt: getStartedAt(status),
    completedAt: getCompletedAt(status),
    outputSnippet: getOutputSnippet(status),
    errorSnippet: getErrorSnippet(status),
    source: entry.source,
    model: entry.resolvedModel,
    thinking: entry.resolvedThinking,
    tools: entry.tools,
    usage: entry.totalUsage,
    inputIndex,
  };
}

export function serializeGroup(
  id: string,
  createdAt: number,
  sessions: AgentRow[],
): AgentRowGroup {
  const statusCounts: Record<string, number> = {};
  for (const session of sessions) {
    statusCounts[session.status] = (statusCounts[session.status] ?? 0) + 1;
  }

  return {
    id,
    createdAt,
    statusCounts,
    sessions,
    isError: sessions.some(session => !isActiveStatusKind(session.status) && session.status !== "completed"),
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
    resumable: config.resumable,
    sourcePath: config.sourcePath,
  };
}

export function listAgentDefinitions(agentRegistry: AgentRegistry) {
  return Array.from(agentRegistry.agents.values()).map(serializeAgentConfig);
}

export function activeOrRetainedAgents<T extends AgentView>(agents: T[]): T[] {
  return agents.filter(a => isActiveStatusKind(a.status.kind) || a.resumable);
}

export function canResumeSubagentSession(agent: AgentView): boolean {
  return agent.resumable && agent.status.kind === "done" && agent.status.result.status === "completed";
}

export function canClearSubagentSession(agent: AgentView): boolean {
  return agent.resumable && !isActiveStatusKind(agent.status.kind);
}

export function effectiveStatus(status: AgentStatus): string {
  return status.kind === "done" ? status.result.status : status.kind;
}

export function getStartedAt(status: AgentStatus): number | undefined {
  if (status.kind === "running") return status.startedAt;
  if (status.kind === "done") return status.ran?.startedAt;
  return undefined;
}

export function getCompletedAt(status: AgentStatus): number | undefined {
  return status.kind === "done" ? status.completedAt : undefined;
}

export function getOutputSnippet(status: AgentStatus): string | undefined {
  if (status.kind === "done" && status.result.status === "completed" && status.result.output) {
    return compact(status.result.output, OUTPUT_SNIPPET_LENGTH);
  }
  return undefined;
}

export function getErrorSnippet(status: AgentStatus): string | undefined {
  if (status.kind !== "done") return undefined;
  if (status.result.status === "completed") return undefined;
  return compact(status.result.error ?? status.result.status, OUTPUT_SNIPPET_LENGTH);
}

export function isActiveStatusKind(status: string): boolean {
  return status === "queued" || status === "running";
}

export function compact(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}
