import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import {
  effectiveStatus,
  getActiveTools,
  getSnippet,
  getToolUseCount,
  isActiveStatusKind,
} from "../domain/agent-decisions.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings, type WidgetLayout } from "../config/settings.js";
import { compact } from "./view-helpers.js";
import { applyBold, type Bold, type DisplayLine } from "./text-component.js";
import {
  abbreviateTokens,
  orderAsTree,
  plural,
  rowElapsed,
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

export type WidgetSectionTitle = "Background" | "Retained";

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
    if (parent.attempt.dispatch === "background") return true;
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
  const background = agents.filter(a =>
    (isActiveStatusKind(a.status.kind) && a.attempt.dispatch === "background")
    || a.retention.reasons.includes("background-result"),
  );
  const backgroundIds = new Set(background.map(agent => agent.id));
  const retained = agents.filter(a =>
    !backgroundIds.has(a.id) && a.retention.catalog === "persistent",
  );
  const foregroundRunning = agents.filter(
    a => a.attempt.dispatch === "foreground"
      && a.retention.catalog === "transient"
      && isActiveStatusKind(a.status.kind)
      && !hasBackgroundAncestor(a, byId),
  ).length;

  const sections: WidgetSection[] = [];
  const backgroundSection = buildSection("Background", background, display, byId);
  if (backgroundSection) sections.push(backgroundSection);
  const retainedSection = buildSection("Retained", retained, display, byId);
  if (retainedSection) sections.push(retainedSection);

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
  const retained = model.sections.find(section => section.title === "Retained");
  const leftLines = background ? renderWidgetSectionLines(background, model, now, formatRow) : [];
  const rightLines = retained ? renderWidgetSectionLines(retained, model, now, formatRow) : [];
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
    if (!isActiveStatusKind(agent.status.kind) && agent.retention.catalog !== "persistent") continue;

    if (agent.status.kind === "running") counts.running++;
    else if (agent.status.kind === "queued") counts.queued++;
    else if (agent.status.kind === "done") {
      if (agent.status.outcome === "completed") counts.ready++;
      else counts.error++;
    }
  }

  const rowAgents = agents.filter(agent => {
    if (isActiveStatusKind(agent.status.kind)) return true;
    return agent.retention.catalog === "persistent" && display.widgetShowRetainedSessions;
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
  if (row.attempt.dispatch === "background") parts.push("dispatch:background");

  if (!isActiveStatusKind(status)) {
    const rawTail = getSnippet(row.status);
    const tail = status === "completed" ? "" : `:${rawTail ? compact(rawTail, display.outputSnippetLength) : status}`;
    parts.push(`outcome:${status}${tail}`);
  }

  return parts.join(" · ");
}

export function formatSessionIdentityLine(row: AgentSnapshot, now: number, bold?: Bold, staticRunning = false): DisplayLine {
  const { glyph, color } = staticRunning && effectiveStatus(row.status) === "running"
    ? { glyph: "●", color: "accent" as const }
    : statusPresentation(row.status, now);
  const name = applyBold(bold, row.config.name);
  const label = row.label ? `  ${row.label}` : "";
  return {
    text: `  ${glyph} ${name}${label}`,
    segments: [
      { text: "  " },
      { text: glyph, color },
      { text: " " },
      { text: name, color: "text" },
      ...(label ? [{ text: label, color: "text" as const }] : []),
    ],
  };
}

export function formatRunSessionLine(row: AgentSnapshot, now: number, bold?: Bold, staticRunning = false): DisplayLine {
  const line = formatSessionIdentityLine(row, now, bold, staticRunning);
  const metadata = [
    ...(row.attempt.kind === "resume" ? ["attempt:resume"] : []),
    plural(getToolUseCount(row), "tool call"),
    plural(row.usage?.totalTokens ?? 0, "token"),
    rowElapsed(row, now),
  ].join(" · ");
  return {
    ...line,
    text: `${line.text}  ${metadata}`,
    segments: [...(line.segments ?? []), { text: `  ${metadata}`, color: "dim" }],
  };
}

function sessionRowSegments(
  row: AgentSnapshot,
  now: number,
  name: string,
  options: { status?: string; toolCount: boolean; activeTool?: boolean },
) {
  const parts = [
    name,
    ...(row.attempt.kind === "resume" ? ["attempt:resume"] : []),
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
