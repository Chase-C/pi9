import type { Usage } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentGroupView, AgentView } from "../domain/agent-view.js";
import { serializeGroup } from "./serialize.js";
import {
  MESSAGE_SNIPPET_LENGTH,
  canClearSubagentSession,
  canResumeSubagentSession,
  compact,
  effectiveStatus,
  getActiveTools,
  getCompletedAt,
  getSnippet,
  getSnippetLabel,
  getStartedAt,
  getToolUseCount,
  isActiveStatusKind,
} from "./view-helpers.js";

type Theme = { fg?: (color: string, text: string) => string } | undefined;

export function formatAgentConfigSummary(config: AgentConfig): string {
  const badges = [config.source, config.resumable ? "resumable" : undefined].filter(Boolean);
  return [config.name, ...badges, config.description].join(" · ");
}

export function formatAgentConfigInspect(config: AgentConfig): string[] {
  const lines = [
    `Name: ${config.name}`,
    `Description: ${config.description}`,
    `Source: ${config.source}`,
    `Model: ${config.model ?? "default"}`,
    `Thinking: ${config.thinking ?? "default"}`,
    `Tools: ${config.tools?.length ? config.tools.join(", ") : "default"}`,
    `Resumable: ${config.resumable}`,
  ];
  if (config.sourcePath) lines.push(`Path: ${config.sourcePath}`);
  return lines;
}

export function formatSubagentSessionSummary(agent: AgentView): string {
  const badges = [
    agent.config.resumable ? "resumable" : undefined,
    `session:${agent.id}`,
  ].filter(Boolean);
  return [agent.config.name, effectiveStatus(agent.status), ...badges].join(" · ");
}

export function formatSubagentSessionInspect(agent: AgentView, now = Date.now()): string[] {
  const status = agent.status;
  const startedAt = getStartedAt(status);
  const completedAt = getCompletedAt(status);
  const elapsed = formatElapsed(startedAt ?? agent.createdAt, completedAt ?? now);
  const activeTools = getActiveTools(agent);

  const lines = [
    `Session ${agent.id}`,
    `Status: ${effectiveStatus(status)}${agent.config.resumable ? " · resumable" : ""}`,
    `Agent: ${agent.config.name}${agent.config.source ? ` (${agent.config.source})` : ""}`,
  ];

  if (agent.config.description) lines.push(`Description: ${agent.config.description}`);
  if (agent.config.model || agent.config.thinking) {
    lines.push(`Model: ${agent.config.model ?? "default"}${agent.config.thinking ? ` · thinking:${agent.config.thinking}` : ""}`);
  }
  lines.push(`Tools: ${agent.config.tools?.length ? agent.config.tools.join(", ") : "default"}`);
  if (agent.config.sourcePath) lines.push(`Path: ${agent.config.sourcePath}`);
  if (activeTools.length) {
    lines.push(`Active tool${activeTools.length === 1 ? "" : "s"}: ${activeTools.join(", ")}`);
  }
  const toolUses = getToolUseCount(agent);
  lines.push(`Progress: ${agent.activity.turns} turn${agent.activity.turns === 1 ? "" : "s"} · ${toolUses} tool use${toolUses === 1 ? "" : "s"} · ${agent.activity.compactions} compaction${agent.activity.compactions === 1 ? "" : "s"}`);
  if (agent.usage) lines.push(`Usage: ${formatUsage(agent.usage)}`);
  lines.push(`Timestamps: created ${formatTimestamp(agent.createdAt)}${startedAt ? ` · started ${formatTimestamp(startedAt)}` : ""}${completedAt ? ` · completed ${formatTimestamp(completedAt)}` : ""} · elapsed ${elapsed}`);

  const snippet = getSnippet(status);
  const label = getSnippetLabel(status);
  if (snippet && label) lines.push(`${label}: ${snippet}`);
  if (agent.activity.messageSnippet) lines.push(`Message: ${compact(agent.activity.messageSnippet, MESSAGE_SNIPPET_LENGTH)}`);

  const actions = ["inspect"];
  if (canResumeSubagentSession(agent)) actions.push("resume");
  if (canClearSubagentSession(agent)) actions.push("clear");
  lines.push(`Actions: ${actions.join(", ")}`);
  return lines;
}

export function formatSubagentSessionLine(agent: AgentView, now = Date.now()): string {
  return formatViewSessionLine(agent, now);
}

export function formatWidgetLines(agents: AgentView[], now = Date.now()): string[] {
  const visible = agents.filter(a => isActiveStatusKind(a.status.kind) || a.config.resumable);
  if (visible.length === 0) return [];
  if (visible.length === 1) return [formatSubagentSessionLine(visible[0], now)];

  const active = visible.filter(a => isActiveStatusKind(a.status.kind)).length;
  const retained = visible.length - active;
  return [`Subagents: ${active} active · ${retained} retained`];
}

export function formatSubagentToolLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
): string[] {
  const group = extractGroup(details);
  if (group) {
    if (!expanded) return [formatViewGroupLine(group)];
    return group.sessions.map(row => formatViewSessionLine(row, now));
  }

  const sessions = extractSessions(details);
  if (sessions.length === 0) return ["No subagent sessions."];

  if (!expanded && sessions.length > 1) {
    return [formatViewGroupLine(serializeGroup(sessions))];
  }

  return sessions.map(row => formatViewSessionLine(row, now));
}

export function createSubagentTextComponent(
  details: unknown,
  expanded: boolean,
  theme: Theme,
  now = Date.now(),
) {
  const lines = formatSubagentToolLines(details, expanded, now);
  const text = lines.map(line => colorLine(line, theme)).join("\n");
  return new Text(text, 0, 0);
}

function formatViewGroupLine(group: AgentGroupView): string {
  const knownStatuses = ["queued", "running", "completed", "error", "interrupted", "skipped", "aborted"];
  const counts = knownStatuses
    .filter(status => group.statusCounts[status])
    .map(status => `${group.statusCounts[status]} ${status}`);
  const extraCounts = Object.keys(group.statusCounts)
    .filter(status => !knownStatuses.includes(status))
    .sort()
    .map(status => `${group.statusCounts[status]} ${status}`);
  const active = group.sessions.some(session => isActiveStatusKind(effectiveStatus(session.status)));
  const outcome = group.isError ? "error" : active ? "running" : "completed";
  return [`${group.sessions.length} subagents`, ...counts, ...extraCounts, `outcome:${outcome}`].join(" · ");
}

function formatViewSessionLine(row: AgentView, now: number): string {
  const elapsed = formatElapsed((getStartedAt(row.status) ?? row.createdAt), getCompletedAt(row.status) ?? now);
  const status = effectiveStatus(row.status);
  const toolUses = getToolUseCount(row);
  const parts = [
    row.config.name,
    status,
    `${row.activity.turns} turn${row.activity.turns === 1 ? "" : "s"}`,
    `${toolUses} tool${toolUses === 1 ? "" : "s"}`,
    elapsed,
  ];

  const activeTool = getActiveTools(row).at(-1);
  if (activeTool) parts.push(`tool:${activeTool}`);
  if (row.activity.messageSnippet) parts.push(`"${row.activity.messageSnippet}"`);

  if (!isActiveStatusKind(status)) {
    if (status === "completed") {
      parts.push(`outcome:completed`);
    } else {
      parts.push(`outcome:${status}:${getSnippet(row.status) ?? status}`);
    }
  }

  return parts.join(" · ");
}

function extractGroup(details: unknown): AgentGroupView | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as { group?: unknown };
  if (record.group && typeof record.group === "object") return record.group as AgentGroupView;
  return undefined;
}

function extractSessions(details: unknown): AgentView[] {
  if (!details || typeof details !== "object") return [];
  const record = details as { sessions?: unknown };
  if (Array.isArray(record.sessions)) return record.sessions as AgentView[];
  return [];
}

function formatElapsed(from: number, to: number) {
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function formatTimestamp(value: number) {
  return new Date(value).toISOString();
}

function formatUsage(usage: Usage) {
  const tokens = `${usage.totalTokens} tokens`;
  const cost = usage.cost?.total ? ` · $${usage.cost.total.toFixed(4)}` : "";
  return `${tokens}${cost}`;
}

function colorLine(line: string, theme: Theme) {
  if (!theme?.fg) return line;
  if (line.includes("status:error") || line.includes("outcome:error")) return theme.fg("error", line);
  if (line.includes("status:aborted") || line.includes("outcome:aborted")) return theme.fg("warning", line);
  if (line.includes("status:interrupted") || line.includes("outcome:interrupted")) return theme.fg("warning", line);
  if (line.includes("status:skipped") || line.includes("outcome:skipped")) return theme.fg("warning", line);
  if (line.includes("completed") || line.includes("outcome:completed")) return theme.fg("success", line);
  if (line.includes("running")) return theme.fg("accent", line);
  return theme.fg("muted", line);
}
