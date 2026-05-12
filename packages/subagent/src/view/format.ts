import type { Usage } from "@mariozechner/pi-ai";
import { wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";

import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentGroupView, AgentView, AgentViewStatus } from "../domain/agent-view.js";
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

type Theme = { fg?: (color: string, text: string) => string; bold?: (text: string) => string } | undefined;
type DisplayStatus = "queued" | "running" | "completed" | "error" | "warning";
type DisplayLine = { text: string; status?: DisplayStatus; hangingIndent?: number };
type Bold = ((text: string) => string) | undefined;

function applyBold(bold: Bold, text: string): string {
  return bold ? bold(text) : text;
}

export type AgentListingEntry = Omit<AgentConfig, "systemPrompt">;

export type SubagentDetails =
  | { view: "agents"; agents: AgentListingEntry[] }
  | { view: "run"; group: AgentGroupView; results?: unknown; active?: boolean }
  | { view: "inventory"; sessions: AgentView[] };

export type AgentsDetails = Extract<SubagentDetails, { view: "agents" }>;
export type RunDetails = Extract<SubagentDetails, { view: "run" }>;
export type InventoryDetails = Extract<SubagentDetails, { view: "inventory" }>;

export function agentsDetails(agents: AgentListingEntry[]): AgentsDetails {
  return { view: "agents", agents };
}

export function runDetails(
  group: AgentGroupView,
  extras: { results?: unknown; active?: boolean } = {},
): RunDetails {
  return { view: "run", group, ...extras };
}

export function inventoryDetails(sessions: AgentView[]): InventoryDetails {
  return { view: "inventory", sessions };
}

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
  return [agent.label ?? agent.config.name, effectiveStatus(agent.status), ...badges].join(" · ");
}

export function formatSubagentSessionInspect(agent: AgentView, now = Date.now()): string[] {
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
  const label = getSnippetLabel(status);
  if (snippet && label) {
    for (const line of snippetLines(label, snippet, 0)) lines.push(line.text);
  }
  if (agent.activity.messageSnippet) lines.push(`Message: ${compact(agent.activity.messageSnippet, MESSAGE_SNIPPET_LENGTH)}`);

  const actions = ["inspect"];
  if (canResumeSubagentSession(agent)) actions.push("resume");
  if (canClearSubagentSession(agent)) actions.push("clear");
  lines.push(`Actions: ${actions.join(", ")}`);
  return lines;
}

export function formatWidgetLines(agents: AgentView[], now = Date.now()): string[] {
  const visible = agents.filter(a => isActiveStatusKind(a.status.kind) || a.config.resumable);
  return visible.map(agent => formatSessionLine(agent, now));
}

export function formatSubagentToolLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
): string[] {
  return (formatSubagentToolDisplayLines(details, expanded, now) ?? []).map(line => line.text);
}

export function createSubagentTextComponent(
  details: unknown,
  expanded: boolean,
  theme: Theme,
  now = Date.now(),
): Component | undefined {
  // Probe the theme eagerly so a broken theme throws here and renderResult can fall back to plain text.
  if (theme?.fg) theme.fg("muted", "");
  const lines = formatSubagentToolDisplayLines(details, expanded, now, theme?.bold);
  return lines ? new SubagentTextComponent(lines, theme) : undefined;
}

function formatSubagentToolDisplayLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
  bold?: Bold,
): DisplayLine[] | undefined {
  const narrowed = narrowDetails(details);
  if (!narrowed) return undefined;

  switch (narrowed.view) {
    case "agents":
      return formatAgentListLines(narrowed.agents, expanded, bold).map(text => ({ text }));

    case "run": {
      const { sessions } = narrowed.group;
      if (!expanded) return sessions.map(row => formatRunSessionLine(row, now, bold));
      return sessions.flatMap((row, index) =>
        expandedLines(formatRunSessionLine(row, now, bold), row, true, index < sessions.length - 1));
    }

    case "inventory": {
      const { sessions } = narrowed;
      if (sessions.length === 0) return [{ text: "No subagent sessions." }];
      if (!expanded && sessions.length > 1) {
        return [formatViewGroupLine(serializeGroup(sessions))];
      }
      return expanded
        ? sessions.flatMap((row, index) => expandedLines(
            { text: formatSessionLine(row, now, bold), status: statusPresentation(row.status).color },
            row,
            false,
            index < sessions.length - 1,
          ))
        : sessions.map(row => ({ text: formatSessionLine(row, now, bold), status: statusPresentation(row.status).color }));
    }
  }
}

function narrowDetails(details: unknown): SubagentDetails | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as { view?: unknown; agents?: unknown; group?: unknown; sessions?: unknown };
  switch (record.view) {
    case "agents":
      return Array.isArray(record.agents) ? { view: "agents", agents: record.agents as AgentListingEntry[] } : undefined;
    case "run":
      return record.group && typeof record.group === "object"
        ? { view: "run", group: record.group as AgentGroupView }
        : undefined;
    case "inventory":
      return Array.isArray(record.sessions) ? { view: "inventory", sessions: record.sessions as AgentView[] } : undefined;
    default:
      return undefined;
  }
}

const ORDERED_GROUP_STATUSES = ["queued", "running", "completed", "error", "interrupted", "skipped", "aborted"];

function formatViewGroupLine(group: AgentGroupView): DisplayLine {
  const known = new Set(ORDERED_GROUP_STATUSES);
  const format = (status: string) => `${group.statusCounts[status]} ${status}`;
  const counts = ORDERED_GROUP_STATUSES.filter(status => group.statusCounts[status]).map(format);
  const extras = Object.keys(group.statusCounts).filter(status => !known.has(status)).sort().map(format);
  const outcome = groupOutcome(group);
  const outcomeLabel = outcome === "queued" ? "running" : outcome;
  return {
    text: [`${group.sessions.length} subagents`, ...counts, ...extras, `outcome:${outcomeLabel}`].join(" · "),
    status: outcome,
  };
}

function groupOutcome(group: AgentGroupView): DisplayStatus {
  if (group.isError) return "error";
  if (group.sessions.some(s => effectiveStatus(s.status) === "running")) return "running";
  if (group.sessions.some(s => effectiveStatus(s.status) === "queued")) return "queued";
  return "completed";
}

function formatSessionLine(row: AgentView, now: number, bold?: Bold): string {
  const status = effectiveStatus(row.status);
  const parts = [
    applyBold(bold, row.label ?? row.config.name),
    ...(row.resumed ? ["resumed"] : []),
    status,
    plural(row.activity.turns, "turn"),
    plural(getToolUseCount(row), "tool"),
    plural(row.usage?.totalTokens ?? 0, "token"),
    rowElapsed(row, now),
  ];

  const activeTool = getActiveTools(row).at(-1);
  if (activeTool) parts.push(`tool:${activeTool}`);
  if (row.activity.messageSnippet) parts.push(`"${row.activity.messageSnippet}"`);

  if (!isActiveStatusKind(status)) {
    const tail = status === "completed" ? "" : `:${getSnippet(row.status) ?? status}`;
    parts.push(`outcome:${status}${tail}`);
  }

  return parts.join(" · ");
}

function formatRunSessionLine(row: AgentView, now: number, bold?: Bold): DisplayLine {
  const { glyph, color } = statusPresentation(row.status, now);
  const parts = [
    `  ${glyph} ${applyBold(bold, row.config.name)}${(row.label) ? `  ${row.label}` : ""}`,
    ...(row.resumed ? ["resumed"] : []),
    plural(row.activity.turns, "turn"),
    plural(row.usage?.totalTokens ?? 0, "token"),
    rowElapsed(row, now),
  ];

  const activeTool = getActiveTools(row).at(-1);
  if (activeTool) parts.push(`tool:${activeTool}`);
  return { text: parts.join(" · "), status: color };
}

function expandedLines(head: DisplayLine, row: AgentView, includeSnippet: boolean, trailingBlank: boolean): DisplayLine[] {
  const lines = [head];
  appendPrompt(lines, row);
  if (includeSnippet) appendSnippet(lines, row);
  appendToolCounts(lines, row);
  if (trailingBlank) lines.push({ text: "" });
  return lines;
}

function snippetLines(label: string, snippet: string, leadingIndent: number, color?: DisplayStatus): DisplayLine[] {
  const lead = " ".repeat(leadingIndent);
  const continuationIndent = leadingIndent + label.length + 2;
  const continuation = " ".repeat(continuationIndent);
  const [first, ...rest] = snippet.split("\n");
  const head: DisplayLine = { text: `${lead}${label}: ${first}`, status: color, hangingIndent: leadingIndent };
  return [head, ...rest.map(line => ({ text: `${continuation}${line}`, status: color, hangingIndent: continuationIndent }))];
}

function appendSnippet(lines: DisplayLine[], row: AgentView) {
  const snippet = getSnippet(row.status);
  if (!snippet) return;
  const label = effectiveStatus(row.status) === "completed" ? "Result" : "Error";
  lines.push(...snippetLines(label, snippet, 4, statusPresentation(row.status).color));
}

function appendPrompt(lines: DisplayLine[], row: AgentView) {
  if (!row.prompt) return;
  lines.push({ text: "" });
  for (const part of [...row.prompt.split(/\r?\n/), ""]) {
    lines.push({ text: `    ${part}`, hangingIndent: 4 });
  }
}

function appendToolCounts(lines: DisplayLine[], row: AgentView) {
  const counts = aggregateToolCounts(row.activity.toolHistory);
  if (counts.length === 0) return;
  const summary = counts.map(({ name, count }) => `${name} ×${count}`).join(", ");
  lines.push({ text: "" });
  lines.push({ text: `    Tools: ${summary}`, hangingIndent: 4 });
}

function aggregateToolCounts(
  history: AgentView["activity"]["toolHistory"],
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const tool of history) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const RUNNING_GLYPHS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUNNING_GLYPH_INTERVAL_MS = 120;

const STATUS_PRESENTATION: Record<string, { glyph: string; color: DisplayStatus }> = {
  completed: { glyph: "✓", color: "completed" },
  running: { glyph: RUNNING_GLYPHS[0], color: "running" },
  queued: { glyph: "○", color: "queued" },
  error: { glyph: "✗", color: "error" },
};
const FALLBACK_STATUS_PRESENTATION = { glyph: "!", color: "warning" as DisplayStatus };

function statusPresentation(status: AgentViewStatus, now = Date.now()) {
  const effective = effectiveStatus(status);
  if (effective === "running") {
    const frame = Math.floor(now / RUNNING_GLYPH_INTERVAL_MS) % RUNNING_GLYPHS.length;
    return { glyph: RUNNING_GLYPHS[frame], color: "running" as DisplayStatus };
  }
  return STATUS_PRESENTATION[effective] ?? FALLBACK_STATUS_PRESENTATION;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function rowElapsed(row: AgentView, now: number): string {
  return formatElapsed(getStartedAt(row.status) ?? row.createdAt, getCompletedAt(row.status) ?? now);
}

function formatAgentListLines(agents: AgentListingEntry[], expanded: boolean, bold?: Bold): string[] {
  if (!expanded) {
    return agents.slice(0, 8).map(agent => `${applyBold(bold, agent.name)} · ${compact(agent.description, 100)}`);
  }

  return agents.flatMap((agent, index) => {
    const lines = [
      applyBold(bold, agent.name),
      ...agent.description.split(/\r?\n/).map(line => `  ${line}`),
      `  Model: ${agent.model ?? "default"}`,
      `  Thinking: ${agent.thinking ?? "default"}`,
      `  Tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}`,
      `  Skills: ${agent.skills?.length ? agent.skills.join(", ") : "none"}`,
      `  Resumable: ${agent.resumable}`,
    ];
    if (agent.sourcePath) lines.push(`  Path: ${agent.sourcePath}`);
    if (index < agents.length - 1) lines.push("");
    return lines;
  });
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

class SubagentTextComponent implements Component {
  constructor(private readonly lines: DisplayLine[], private readonly theme: Theme) { }

  invalidate(): void { }

  render(width: number): string[] {
    return this.lines.flatMap(line => wrapDisplayLine(line, width).map(wrapped => colorLine(wrapped, line.status, this.theme)));
  }
}

function wrapDisplayLine(line: DisplayLine, width: number): string[] {
  if (!line.text) return [""];
  const indent = line.hangingIndent ?? 0;
  if (indent <= 0 || width <= indent + 1) return wrapTextWithAnsi(line.text, Math.max(1, width));

  const prefix = " ".repeat(indent);
  const content = line.text.startsWith(prefix) ? line.text.slice(indent) : line.text;
  return wrapTextWithAnsi(content, Math.max(1, width - indent)).map(wrapped => `${prefix}${wrapped}`);
}

function colorLine(line: string, status: DisplayStatus | undefined, theme: Theme) {
  if (!theme?.fg) return line;
  if (status === "error") return theme.fg("error", line);
  if (status === "warning") return theme.fg("warning", line);
  if (status === "completed") return theme.fg("success", line);
  if (status === "running") return theme.fg("accent", line);
  return theme.fg("muted", line);
}
