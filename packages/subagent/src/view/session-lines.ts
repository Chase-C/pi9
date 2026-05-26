import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import {
  effectiveStatus,
  getActiveTools,
  getCompletedAt,
  getSnippet,
  getStartedAt,
  getToolUseCount,
  isActiveStatusKind,
} from "../domain/agent-decisions.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../config/settings.js";
import { compact } from "./view-helpers.js";
import { applyBold, type Bold, type DisplayLine } from "./text-component.js";
import {
  formatTimestamp,
  formatUsage,
  orderAsTree,
  plural,
  rowElapsed,
  snippetLines,
  statusPresentation,
} from "./format-helpers.js";

const DEFAULT_DISPLAY = DEFAULT_SUBAGENT_SETTINGS.display;

export function formatSubagentSessionSummary(agent: AgentSnapshot): string {
  return [agent.label ?? agent.config.name, effectiveStatus(agent.status), ...sessionBadges(agent)].join(" · ");
}

function sessionBadges(agent: AgentSnapshot) {
  return [
    agent.config.resumable ? "resumable" : undefined,
    agent.dispatch === "background" ? "dispatch:background" : undefined,
    `session:${agent.id}`,
  ].filter((badge): badge is string => Boolean(badge));
}

export function formatSubagentSessionInspect(
  agent: AgentSnapshot,
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): string[] {
  const status = agent.status;
  const startedAt = getStartedAt(status);
  const completedAt = getCompletedAt(status);
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
  lines.push(`Progress: ${plural(agent.activity.turns, "turn")} · ${plural(toolUses, "tool use")} · ${plural(agent.activity.compactions, "compaction")}`);
  if (agent.usage) lines.push(`Usage: ${formatUsage(agent.usage)}`);
  lines.push(`Timestamps: created ${formatTimestamp(agent.createdAt)}${startedAt ? ` · started ${formatTimestamp(startedAt)}` : ""}${completedAt ? ` · completed ${formatTimestamp(completedAt)}` : ""} · elapsed ${rowElapsed(agent, now)}`);

  const snippet = getSnippet(status);
  if (snippet) {
    // The inspect view is a labeled metadata list, so the output/error keeps a key here even
    // though the run/results body now renders the snippet bare.
    const label = effectiveStatus(status) === "completed" ? "Output" : "Error";
    const rendered = snippetLines(snippet, 0, undefined, display).map(line => line.text);
    rendered[0] = `${label}: ${rendered[0]}`;
    lines.push(...rendered);
  }
  if (agent.activity.messageSnippet) lines.push(`Message: ${compact(agent.activity.messageSnippet, display.messageSnippetLength)}`);

  const actions = ["inspect"];
  if (agent.capabilities.canResume) actions.push("resume");
  if (agent.capabilities.canClear) actions.push("remove");
  lines.push(`Actions: ${actions.join(", ")}`);
  return lines;
}

export function formatWidgetLines(
  agents: AgentSnapshot[],
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): string[] {
  const visible = agents.filter(a => isActiveStatusKind(a.status.kind) || (display.widgetShowRetainedSessions && a.retention === "persistent"));
  return orderAsTree(visible).map(({ agent, depth }) => `${"  ".repeat(depth)}${formatSessionLine(agent, now, undefined, display)}`);
}

export function formatSessionLine(row: AgentSnapshot, now: number, bold?: Bold, display: SubagentDisplaySettings = DEFAULT_DISPLAY): string {
  const status = effectiveStatus(row.status);
  const parts = sessionRowSegments(row, now, applyBold(bold, row.label ?? row.config.name), { status, toolCount: true });

  if (row.activity.messageSnippet) parts.push(`"${compact(row.activity.messageSnippet, display.messageSnippetLength)}"`);
  if (row.dispatch === "background") parts.push("dispatch:background");

  if (!isActiveStatusKind(status)) {
    const rawTail = getSnippet(row.status);
    const tail = status === "completed" ? "" : `:${rawTail ? compact(rawTail, display.outputSnippetLength) : status}`;
    parts.push(`outcome:${status}${tail}`);
  }

  return parts.join(" · ");
}

export function formatRunSessionLine(row: AgentSnapshot, now: number, bold?: Bold): DisplayLine {
  const { glyph, color } = statusPresentation(row.status, now);
  const name = `  ${glyph} ${applyBold(bold, row.config.name)}${(row.label) ? `  ${row.label}` : ""}`;
  return { text: sessionRowSegments(row, now, name, { toolCount: false, activeTool: false }).join(" · "), color };
}

function sessionRowSegments(
  row: AgentSnapshot,
  now: number,
  name: string,
  options: { status?: string; toolCount: boolean; activeTool?: boolean },
) {
  const parts = [
    name,
    ...(row.resumed ? ["resumed"] : []),
    ...(options.status ? [options.status] : []),
    plural(row.activity.turns, "turn"),
    ...(options.toolCount ? [plural(getToolUseCount(row), "tool")] : []),
    plural(row.usage?.totalTokens ?? 0, "token"),
    rowElapsed(row, now),
  ];
  const activeTool = options.activeTool !== false ? getActiveTools(row).at(-1) : undefined;
  if (activeTool) parts.push(`tool:${activeTool}`);
  return parts;
}
