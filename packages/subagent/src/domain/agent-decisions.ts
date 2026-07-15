import type { AgentSnapshot, AgentToolUse, AgentViewStatus } from "./agent-snapshot.js";

export function effectiveStatus(status: AgentViewStatus): string {
  return status.kind === "done" ? status.outcome : status.kind;
}

export function getStartedAt(status: AgentViewStatus): number | undefined {
  if (status.kind === "running") return status.startedAt;
  if (status.kind === "done") return status.startedAt;
  return undefined;
}

export function getQueuedAt(status: AgentViewStatus): number | undefined {
  return status.kind === "queued" ? status.queuedAt : undefined;
}

export function getCompletedAt(status: AgentViewStatus): number | undefined {
  return status.kind === "done" ? status.completedAt : undefined;
}

export function getSnippet(status: AgentViewStatus): string | undefined {
  if (status.kind !== "done") return undefined;
  return status.outcome === "completed" ? status.output : status.error;
}

export function getActiveTools(agent: AgentSnapshot): string[] {
  return activeToolsFromHistory(agent.activity.toolHistory);
}

export function getToolUseCount(agent: AgentSnapshot): number {
  return agent.activity.toolHistory.length;
}

export function isActiveStatusKind(status: string): boolean {
  return status === "queued" || status === "running";
}

function activeToolsFromHistory(history: readonly AgentToolUse[]): string[] {
  return history
    .filter(tool => tool.completedAt === undefined)
    .map(tool => tool.name);
}
