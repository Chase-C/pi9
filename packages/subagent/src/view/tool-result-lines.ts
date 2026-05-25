import type { Component } from "@earendil-works/pi-tui";

import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentGroupView, AgentSnapshot } from "../domain/agent-snapshot.js";
import type { ResultEntry } from "../domain/agent-result.js";
import { effectiveStatus, getSnippet } from "../domain/agent-decisions.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../config/settings.js";
import { compact } from "./view-helpers.js";
import { serializeGroup } from "./serialize.js";
import {
  applyBold,
  SubagentTextComponent,
  type Bold,
  type DisplayLine,
  type DisplayStatus,
  type Theme,
} from "./text-component.js";
import {
  expandedLines,
  orderAsTree,
  plural,
  rowElapsed,
  snippetLines,
  statusColorForOutcome,
  statusPresentation,
} from "./format-helpers.js";
import { formatRunSessionLine, formatSessionLine } from "./session-lines.js";
import {
  parseDetails,
  type AgentListingEntry,
  type BackgroundSpawnHandle,
  type InventoryFilter,
  type RemoveSummary,
} from "./details.js";

const DEFAULT_DISPLAY = DEFAULT_SUBAGENT_SETTINGS.display;

export function formatAgentConfigSummary(config: AgentListingEntry | AgentConfig): string {
  const badges = [config.source, config.resumable ? "resumable" : undefined].filter(Boolean);
  return [config.name, ...badges, config.description].join(" · ");
}

export function formatAgentConfigInspect(config: AgentListingEntry | AgentConfig): string[] {
  return [
    `Name: ${config.name}`,
    `Description: ${config.description}`,
    ...agentConfigMetadataLines(config),
  ];
}

function agentConfigMetadataLines(config: AgentListingEntry | AgentConfig): string[] {
  const lines = [
    `Source: ${config.source}`,
    `Model: ${config.model ?? "default"}`,
    `Thinking: ${config.thinking ?? "default"}`,
    `Tools: ${config.tools?.length ? config.tools.join(", ") : "default"}`,
    `Skills: ${config.skills?.length ? config.skills.join(", ") : "none"}`,
    `Resumable: ${config.resumable}`,
  ];
  if (config.sourcePath) lines.push(`Path: ${config.sourcePath}`);
  return lines;
}

export function formatSubagentToolLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): string[] {
  return (formatSubagentToolDisplayLines(details, expanded, now, undefined, display) ?? []).map(line => line.text);
}

export function createSubagentTextComponent(
  details: unknown,
  expanded: boolean,
  theme: Theme,
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): Component | undefined {
  // Probe the theme eagerly so a broken theme throws here and renderResult can fall back to plain text.
  if (theme?.fg) theme.fg("muted", "");
  const lines = formatSubagentToolDisplayLines(details, expanded, now, theme?.bold, display);
  return lines ? new SubagentTextComponent(lines, theme) : undefined;
}

function formatSubagentToolDisplayLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
  bold: Bold | undefined,
  display: SubagentDisplaySettings,
): DisplayLine[] | undefined {
  const narrowed = parseDetails(details);
  if (!narrowed) return undefined;

  switch (narrowed.view) {
    case "agents":
      return formatAgentListLines(narrowed.agents, expanded, bold, display).map(text => ({ text }));

    case "results":
      return formatResultsLines(narrowed.results, expanded, now, bold, display);

    case "run": {
      const ordered = narrowed.subtree && narrowed.subtree.length > 0
        ? orderAsTree(narrowed.subtree)
        : narrowed.sessions.map(agent => ({ agent, depth: 0 }));
      return expandRows(ordered, expanded, now, bold, display, runRow, true);
    }

    case "inventory": {
      const { sessions, filter } = narrowed;
      if (sessions.length === 0) return [{ text: "No subagent sessions." }];
      if (!expanded && sessions.length > 1) return formatViewGroupLine(serializeGroup(sessions), filter);
      return expandRows(orderAsTree(sessions), expanded, now, bold, display, inventoryRow, false);
    }

    case "remove-summary":
      return formatRemoveSummaryLines(narrowed.summary, expanded);

    case "background-started":
      return formatBackgroundStartedLines(narrowed.handles, narrowed.count, expanded, bold);
  }
}

/**
 * The one head-line-plus-entries renderer behind every count-summary view. Collapsed yields
 * just the head (`total · counts · trailing`); expanded appends each entry's block, optionally
 * separated by a blank line, then any trailer (e.g. a remove-summary errors block).
 */
interface CountSummarySpec<T> {
  total: string;
  counts: string[];
  trailing?: string[];
  headStatus?: DisplayStatus;
  expanded: boolean;
  entries?: readonly T[];
  renderEntry?: (entry: T) => DisplayLine[];
  blankBetween?: boolean;
  trailer?: DisplayLine[];
}

function renderCountSummary<T>(spec: CountSummarySpec<T>): DisplayLine[] {
  const head: DisplayLine = {
    text: [spec.total, ...spec.counts, ...(spec.trailing ?? [])].join(" · "),
    ...(spec.headStatus ? { status: spec.headStatus } : {}),
  };
  if (!spec.expanded) return [head];
  const lines: DisplayLine[] = [head];
  if (spec.entries && spec.renderEntry) {
    for (const entry of spec.entries) {
      if (spec.blankBetween) lines.push({ text: "" });
      lines.push(...spec.renderEntry(entry));
    }
  }
  if (spec.trailer) lines.push(...spec.trailer);
  return lines;
}

/** Ordered `${n} ${key}` segments: known keys first in `order`, then any extras alphabetically. */
function orderedCountSegments(counts: Map<string, number>, order: readonly string[]): string[] {
  const known = new Set(order);
  const segments: string[] = [];
  for (const key of order) {
    const count = counts.get(key);
    if (count) segments.push(`${count} ${key}`);
  }
  for (const key of [...counts.keys()].filter(k => !known.has(k)).sort()) {
    const count = counts.get(key);
    if (count) segments.push(`${count} ${key}`);
  }
  return segments;
}

type RowRenderer = (row: AgentSnapshot, now: number, bold: Bold | undefined, display: SubagentDisplaySettings) => DisplayLine;

const runRow: RowRenderer = (row, now, bold) => formatRunSessionLine(row, now, bold);
const inventoryRow: RowRenderer = (row, now, bold, display) => ({
  text: formatSessionLine(row, now, bold, display),
  status: statusPresentation(row.status).color,
});

/**
 * The single per-row tree-expansion path shared by the `run` and `inventory` views. Each row is
 * rendered by {@link RowRenderer}, depth-indented, and — when expanded — followed by its prompt,
 * optional snippet, and tool counts via {@link expandedLines}.
 */
function expandRows(
  ordered: Array<{ agent: AgentSnapshot; depth: number }>,
  expanded: boolean,
  now: number,
  bold: Bold | undefined,
  display: SubagentDisplaySettings,
  renderRow: RowRenderer,
  includeSnippet: boolean,
): DisplayLine[] {
  const withIndent = ({ agent, depth }: { agent: AgentSnapshot; depth: number }): DisplayLine => {
    const line = renderRow(agent, now, bold, display);
    return depth > 0 ? { ...line, text: `${"  ".repeat(depth)}${line.text}` } : line;
  };
  if (!expanded) return ordered.map(withIndent);
  return ordered.flatMap((entry, index) =>
    expandedLines(withIndent(entry), entry.agent, includeSnippet, index < ordered.length - 1, display));
}

/**
 * Count-segment order for the unified results head. Terminal outcomes and the two pending
 * states share one ordered list; a synchronous run only ever produces terminal entries, while a
 * background poll can also carry `queued`/`running` (pending) and session-error entries.
 */
const RESULT_COUNT_ORDER = ["completed", "running", "queued", "error", "aborted", "interrupted", "skipped"] as const;

function formatResultsLines(entries: readonly ResultEntry[], expanded: boolean, now: number, bold: Bold | undefined, display: SubagentDisplaySettings): DisplayLine[] {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  let hasFailure = false;
  let hasPending = false;
  for (const entry of entries) {
    if ("error" in entry) { bump("error"); hasFailure = true; continue; }
    const status = effectiveStatus(entry.snapshot.status);
    bump(status);
    if (status === "queued" || status === "running") hasPending = true;
    else if (status !== "completed") hasFailure = true;
  }
  return renderCountSummary({
    total: plural(entries.length, "result"),
    counts: orderedCountSegments(counts, RESULT_COUNT_ORDER),
    headStatus: hasFailure ? "error" : hasPending ? "running" : "completed",
    expanded,
    entries,
    renderEntry: entry => resultEntryLines(entry, now, bold, display),
    blankBetween: true,
  });
}

/** One result entry: a terminal snapshot's block, a still-pending session row, or a bad id. */
function resultEntryLines(entry: ResultEntry, now: number, bold: Bold | undefined, display: SubagentDisplaySettings): DisplayLine[] {
  if ("error" in entry) {
    return [{ text: `${entry.sessionId} · error: ${entry.error}`, status: "error" }];
  }
  const snapshot = entry.snapshot;
  const status = effectiveStatus(snapshot.status);
  if (status === "queued" || status === "running") {
    const labelSegment = snapshot.label ? `  ${snapshot.label}` : "";
    return [{
      text: `${applyBold(bold, snapshot.config.name)}${labelSegment} · ${status} · ${rowElapsed(snapshot, now)}`,
      status: statusColorForOutcome(status),
    }];
  }
  return resultBlock(snapshot, bold, display);
}

function resultBlock(snapshot: AgentSnapshot, bold: Bold | undefined, display: SubagentDisplaySettings): DisplayLine[] {
  const status = effectiveStatus(snapshot.status);
  const color = statusColorForOutcome(status);
  const labelSegment = snapshot.label ? `  ${snapshot.label}` : "";
  // Persistent sessions are retained and collectable, so surface the handle; transient ones vanish
  // after the run. This matches the gating on the projected top-level `sessionId`.
  const sessionId = snapshot.retention === "persistent" ? snapshot.id : undefined;
  const resumed = snapshot.status.kind === "done" && snapshot.status.resumed === true;
  const segments = [
    `${applyBold(bold, snapshot.config.name)}${labelSegment}`,
    status,
    ...(sessionId ? [`session:${sessionId}`] : []),
    ...(resumed ? ["resumed"] : []),
  ];
  const lines: DisplayLine[] = [{ text: segments.join(" · "), status: color }];
  const raw = getSnippet(snapshot.status);
  const snippet = status === "completed" ? raw : raw ?? status;
  if (snippet) {
    lines.push(...snippetLines(status === "completed" ? "Result" : "Error", snippet, 2, color, display));
  }
  return lines;
}

function formatBackgroundStartedLines(handles: BackgroundSpawnHandle[], count: number, expanded: boolean, bold?: Bold): DisplayLine[] {
  return renderCountSummary({
    total: `${plural(count, "background subagent")} started`,
    counts: [],
    expanded,
    entries: handles,
    renderEntry: handle => [{
      text: handle.label
        ? `  ${applyBold(bold, handle.label)} · ${handle.sessionId}`
        : `  ${applyBold(bold, handle.sessionId)}`,
    }],
    blankBetween: false,
  });
}

function formatRemoveSummaryLines(summary: RemoveSummary, expanded: boolean): DisplayLine[] {
  const errors = summary.errors ?? [];
  return renderCountSummary({
    total: `Removed ${plural(summary.removed, "session")}`,
    counts: [
      ...(summary.aborted > 0 ? [`aborted ${summary.aborted}`] : []),
      ...(errors.length > 0 ? [plural(errors.length, "error")] : []),
    ],
    expanded,
    entries: summary.sessionIds,
    renderEntry: id => [{ text: `  ${id}` }],
    blankBetween: false,
    trailer: errors.length > 0
      ? [{ text: "" }, { text: "Errors:" }, ...errors.map(entry => ({ text: `  ${entry.sessionId}: ${entry.error}`, status: "error" as const }))]
      : undefined,
  });
}

const ORDERED_GROUP_STATUSES = ["queued", "running", "completed", "error", "interrupted", "skipped", "aborted"];

function formatViewGroupLine(group: AgentGroupView, filter?: InventoryFilter): DisplayLine[] {
  const outcome = groupOutcome(group);
  const outcomeLabel = outcome === "queued" ? "running" : outcome;
  return renderCountSummary({
    total: `${group.sessions.length} subagents`,
    counts: orderedCountSegments(new Map(Object.entries(group.statusCounts)), ORDERED_GROUP_STATUSES),
    trailing: [
      `outcome:${outcomeLabel}`,
      ...(filter?.status && filter.status.length > 0 ? [`filter:${filter.status.join(",")}`] : []),
    ],
    headStatus: outcome,
    expanded: false,
  });
}

function groupOutcome(group: AgentGroupView): DisplayStatus {
  if (group.isError) return "error";
  if (group.sessions.some(s => effectiveStatus(s.status) === "running")) return "running";
  if (group.sessions.some(s => effectiveStatus(s.status) === "queued")) return "queued";
  return "completed";
}

function formatAgentListLines(agents: AgentListingEntry[], expanded: boolean, bold: Bold | undefined, display: SubagentDisplaySettings = DEFAULT_DISPLAY): string[] {
  if (!expanded) {
    return agents.slice(0, display.collapsedAgentListLimit).map(agent => `${applyBold(bold, agent.name)} · ${compact(agent.description, display.collapsedDescriptionLength)}`);
  }

  return agents.flatMap((agent, index) => {
    const lines = [
      applyBold(bold, agent.name),
      ...agent.description.split(/\r?\n/).map(line => `  ${line}`),
      ...agentConfigMetadataLines(agent).map(line => `  ${line}`),
    ];
    if (index < agents.length - 1) lines.push("");
    return lines;
  });
}
