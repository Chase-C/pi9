import type { AgentToolUse, AgentView, AgentViewStatus } from "../domain/agent-view.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../ui/settings.js";

export const PROMPT_PREVIEW_LENGTH = DEFAULT_SUBAGENT_SETTINGS.display.promptPreviewLength;
export const MESSAGE_SNIPPET_LENGTH = DEFAULT_SUBAGENT_SETTINGS.display.messageSnippetLength;
export const OUTPUT_SNIPPET_LENGTH = DEFAULT_SUBAGENT_SETTINGS.display.outputSnippetLength;
export const OUTPUT_SNIPPET_MAX_LINES = DEFAULT_SUBAGENT_SETTINGS.display.outputSnippetMaxLines;

let activeDisplaySettings: SubagentDisplaySettings = { ...DEFAULT_SUBAGENT_SETTINGS.display };

export function configureSubagentDisplay(settings: Partial<SubagentDisplaySettings> | undefined) {
  activeDisplaySettings = { ...DEFAULT_SUBAGENT_SETTINGS.display, ...settings };
}

export function getSubagentDisplaySettings(): SubagentDisplaySettings {
  return activeDisplaySettings;
}

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

export function compactMultiline(value: string, maxLength: number, maxLines = OUTPUT_SNIPPET_MAX_LINES) {
  const rawLines = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.replace(/[^\S\n]+/g, " ").trim());

  // Collapse runs of blank lines and trim blank lines from edges.
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line === "" && lines[lines.length - 1] === "") continue;
    lines.push(line);
  }
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  let truncated = false;
  let limited = lines;
  if (limited.length > maxLines) {
    limited = limited.slice(0, maxLines);
    truncated = true;
  }

  let result = limited.join("\n");
  if (result.length > maxLength) {
    result = result.slice(0, Math.max(0, maxLength - 1)).trimEnd();
    truncated = true;
  }
  return truncated ? `${result}…` : result;
}

function activeToolsFromHistory(history: readonly AgentToolUse[]): string[] {
  return history
    .filter(tool => tool.completedAt === undefined)
    .map(tool => tool.name);
}
