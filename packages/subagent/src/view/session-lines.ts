import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

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
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings, type WidgetLayout } from "../config/settings.js";
import { compact } from "./view-helpers.js";
import { applyBold, type Bold, type DisplayLine } from "./text-component.js";
import {
  abbreviateTokens,
  formatTimestamp,
  formatUsage,
  orderAsTree,
  plural,
  rowElapsed,
  snippetLines,
  statusPresentation,
} from "./format-helpers.js";
import {
  hasBothColumnSections,
  maxLineWidth,
  resolveWidgetLayout,
  WIDGET_COLUMN_GUTTER,
  zipWidgetColumns,
} from "./widget-layout.js";

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
  if (agent.capabilities.canRemove) actions.push("remove");
  lines.push(`Actions: ${actions.join(", ")}`);
  return lines;
}

export type WidgetSectionTitle = "Background" | "Resumable";

export type WidgetRow = {
  glyph: string;
  color: ThemeColor;
  name: string;
  elapsed: string;
  tokens?: string;
  activeTool?: string;
  parentName?: string;
};

export function hasBackgroundAncestor(
  agent: AgentSnapshot,
  byId: Map<string, AgentSnapshot>,
): boolean {
  let parentId = agent.parentSessionId;
  while (parentId !== undefined) {
    const parent = byId.get(parentId);
    if (!parent) return false;
    if (parent.dispatch === "background") return true;
    parentId = parent.parentSessionId;
  }
  return false;
}

function parentDisplayName(agent: AgentSnapshot, byId: Map<string, AgentSnapshot>): string | undefined {
  const parentId = agent.parentSessionId;
  if (parentId === undefined) return undefined;
  const parent = byId.get(parentId);
  if (!parent) return undefined;
  return parent.label ?? parent.config.name;
}

export type WidgetSection = {
  title: WidgetSectionTitle;
  counts: { running: number; queued: number; ready: number; error: number };
  agents: AgentSnapshot[];
  overflow: number;
};

export type WidgetModel = {
  sections: WidgetSection[];
  byId: Map<string, AgentSnapshot>;
  footer?: string;
};

export function buildWidgetModel(
  agents: AgentSnapshot[],
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): WidgetModel {
  const byId = new Map(agents.map(a => [a.id, a]));
  const background = agents.filter(a => a.dispatch === "background");
  const resumable = agents.filter(a => a.dispatch === "foreground" && a.retention === "persistent");
  const foregroundRunning = agents.filter(
    a => a.dispatch === "foreground"
      && a.retention === "transient"
      && isActiveStatusKind(a.status.kind)
      && !hasBackgroundAncestor(a, byId),
  ).length;

  const sections: WidgetSection[] = [];
  const backgroundSection = buildSection("Background", background, display, byId);
  if (backgroundSection) sections.push(backgroundSection);
  const resumableSection = buildSection("Resumable", resumable, display, byId);
  if (resumableSection) sections.push(resumableSection);

  if (sections.length === 0) return { sections: [], byId };

  const footer = display.widgetShowForeground && foregroundRunning > 0
    ? `+${foregroundRunning} foreground running`
    : undefined;
  return { sections, byId, ...(footer ? { footer } : {}) };
}

export type WidgetRowFormatter = (row: WidgetRow) => string;

export type RenderWidgetOptions = {
  layout: WidgetLayout;
  width: number;
};

export function renderWidgetModelLines(
  model: WidgetModel,
  now: number,
  formatRow: WidgetRowFormatter,
  options?: RenderWidgetOptions,
): string[] {
  if (!options) return renderWidgetModelStacked(model, now, formatRow);

  const background = model.sections.find(section => section.title === "Background");
  const resumable = model.sections.find(section => section.title === "Resumable");
  const leftLines = background ? renderWidgetSectionLines(background, model, now, formatRow) : [];
  const rightLines = resumable ? renderWidgetSectionLines(resumable, model, now, formatRow) : [];
  const leftNaturalWidth = maxLineWidth(leftLines);

  if (resolveWidgetLayout(options.layout, options.width, hasBothColumnSections(model.sections), leftNaturalWidth) === "columns") {
    return renderWidgetModelColumns(leftLines, rightLines, model.footer, options.width);
  }
  return renderWidgetModelStacked(model, now, formatRow);
}

function renderWidgetModelStacked(
  model: WidgetModel,
  now: number,
  formatRow: WidgetRowFormatter,
): string[] {
  const lines: string[] = [];
  for (const section of model.sections) {
    lines.push(...renderWidgetSectionLines(section, model, now, formatRow));
  }
  if (model.footer) lines.push(model.footer);
  return lines;
}

function renderWidgetModelColumns(
  leftLines: string[],
  rightLines: string[],
  footer: string | undefined,
  width: number,
): string[] {
  const lines = zipWidgetColumns(leftLines, rightLines, width, WIDGET_COLUMN_GUTTER);
  if (footer) lines.push(truncateToWidth(footer, width, "", true));
  return lines;
}

function renderWidgetSectionLines(
  section: WidgetSection,
  model: WidgetModel,
  now: number,
  formatRow: WidgetRowFormatter,
  maxWidth?: number,
): string[] {
  const lines: string[] = [];
  const header = formatSectionHeader(section);
  lines.push(maxWidth ? truncateToWidth(header, maxWidth) : header);
  for (const agent of section.agents) {
    const row = formatRow(toWidgetRow(agent, now, model.byId));
    lines.push(maxWidth ? truncateToWidth(row, maxWidth) : row);
  }
  if (section.overflow > 0) {
    const overflow = `  +${section.overflow} more`;
    lines.push(maxWidth ? truncateToWidth(overflow, maxWidth) : overflow);
  }
  return lines;
}

export function stringifyWidgetModel(model: WidgetModel, now = Date.now()): string[] {
  return renderWidgetModelLines(model, now, formatWidgetRow);
}

export function formatWidgetLines(
  agents: AgentSnapshot[],
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): string[] {
  const model = buildWidgetModel(agents, now, display);
  return stringifyWidgetModel(model, now);
}

function buildSection(
  title: WidgetSectionTitle,
  agents: AgentSnapshot[],
  display: SubagentDisplaySettings,
  byId: Map<string, AgentSnapshot>,
): WidgetSection | undefined {
  const counts = { running: 0, queued: 0, ready: 0, error: 0 };
  for (const agent of agents) {
    if (!isActiveStatusKind(agent.status.kind) && agent.retention !== "persistent") continue;

    if (agent.status.kind === "running") counts.running++;
    else if (agent.status.kind === "queued") counts.queued++;
    else if (agent.status.kind === "done") {
      if (agent.status.outcome === "completed") counts.ready++;
      else counts.error++;
    }
  }

  const rowAgents = agents.filter(agent => {
    if (isActiveStatusKind(agent.status.kind)) return true;
    return agent.retention === "persistent" && display.widgetShowRetainedSessions;
  });
  const sorted = sortWidgetAgents(rowAgents);
  const maxRows = display.widgetMaxRowsPerSection;
  const visible = sorted.slice(0, maxRows);
  const overflow = Math.max(0, sorted.length - visible.length);

  if (visible.length === 0 && counts.running === 0 && counts.queued === 0 && counts.ready === 0 && counts.error === 0) {
    return undefined;
  }

  return {
    title,
    counts,
    agents: visible,
    overflow,
  };
}

function sortWidgetAgents(agents: AgentSnapshot[]): AgentSnapshot[] {
  const priority = (agent: AgentSnapshot): number => {
    if (agent.status.kind === "running") return 0;
    if (agent.status.kind === "queued") return 1;
    return 2;
  };
  return [...agents].sort((a, b) => priority(a) - priority(b) || a.createdAt - b.createdAt);
}

function toWidgetRow(agent: AgentSnapshot, now: number, byId: Map<string, AgentSnapshot>): WidgetRow {
  const { glyph, color } = statusPresentation(agent.status, now);
  const tokens = abbreviateTokens(agent.usage?.totalTokens ?? 0);
  const activeTool = isActiveStatusKind(agent.status.kind) ? getActiveTools(agent).at(-1) : undefined;
  const parentName = parentDisplayName(agent, byId);
  return {
    glyph,
    color,
    name: agent.label ?? agent.config.name,
    elapsed: rowElapsed(agent, now),
    ...(tokens ? { tokens } : {}),
    ...(activeTool ? { activeTool } : {}),
    ...(parentName ? { parentName } : {}),
  };
}

export function formatSectionHeader(section: WidgetSection): string {
  const parts: string[] = [section.title];
  const { running, queued, ready, error } = section.counts;
  if (running) parts.push(`${running} running`);
  if (queued) parts.push(`${queued} queued`);
  if (ready) parts.push(`${ready} ready`);
  if (error) parts.push(`${error} error`);
  return parts.join(" · ");
}

export function formatWidgetRowBody(row: WidgetRow): string {
  const parts = [row.name, row.elapsed];
  if (row.tokens) parts.push(row.tokens);
  if (row.activeTool) parts.push(`tool:${row.activeTool}`);
  if (row.parentName) parts.push(`↳ ${row.parentName}`);
  return parts.join(" · ");
}

export function formatWidgetRow(row: WidgetRow): string {
  return `  ${row.glyph} ${formatWidgetRowBody(row)}`;
}

export function formatThemedWidgetRow(row: WidgetRow, theme: { fg?(color: string, text: string): string } | undefined): string {
  const glyph = theme?.fg ? theme.fg(row.color, row.glyph) : row.glyph;
  return `  ${glyph} ${formatWidgetRowBody(row)}`;
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
