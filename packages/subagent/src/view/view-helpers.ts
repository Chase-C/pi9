import type { AgentToolUse, AgentView, AgentViewStatus } from "../domain/agent-view.js";

export const PROMPT_PREVIEW_LENGTH = 120;
export const MESSAGE_SNIPPET_LENGTH = 200;
export const OUTPUT_SNIPPET_LENGTH = 200;

export function activeOrRetainedAgents<T extends { status: { kind: string }; resumable: boolean }>(agents: T[]): T[] {
  return agents.filter(a => isActiveStatusKind(a.status.kind) || a.resumable);
}

export function canResumeSubagentSession(agent: AgentView): boolean {
  return agent.config.resumable && agent.status.kind === "done" && agent.status.outcome === "completed";
}

export function canClearSubagentSession(agent: AgentView): boolean {
  return agent.config.resumable && !isActiveStatusKind(agent.status.kind);
}

export function effectiveStatus(status: AgentViewStatus): string {
  return status.kind === "done" ? status.outcome : status.kind;
}

export function getStartedAt(status: AgentViewStatus): number | undefined {
  if (status.kind === "running") return status.startedAt;
  if (status.kind === "done") return status.startedAt;
  return undefined;
}

export function getCompletedAt(status: AgentViewStatus): number | undefined {
  return status.kind === "done" ? status.completedAt : undefined;
}

export function getSnippet(status: AgentViewStatus): string | undefined {
  return status.kind === "done" ? status.snippet : undefined;
}

export function getSnippetLabel(status: AgentViewStatus): "Output" | "Error" | undefined {
  if (status.kind !== "done" || !status.snippet) return undefined;
  return status.outcome === "completed" ? "Output" : "Error";
}

export function getActiveTools(agent: AgentView): string[] {
  return activeToolsFromHistory(agent.activity.toolHistory);
}

export function getToolUseCount(agent: AgentView): number {
  return agent.activity.toolHistory.length;
}

export function isActiveStatusKind(status: string): boolean {
  return status === "queued" || status === "running";
}

export function compact(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

function activeToolsFromHistory(history: readonly AgentToolUse[]): string[] {
  return history
    .filter(tool => tool.completedAt === undefined)
    .map(tool => tool.name);
}
