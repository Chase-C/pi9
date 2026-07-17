import type { Component } from "@earendil-works/pi-tui";

import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import type { ResultEntry } from "../domain/agent-result.js";
import {
  effectiveStatus,
  getCompletedAt,
  getQueuedAt,
  getStartedAt,
  isActiveStatusKind,
} from "../domain/agent-decisions.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../config/settings.js";
import { compact } from "./view-helpers.js";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  applyBold,
  SubagentTextComponent,
  type Bold,
  type DisplayLine,
} from "./text-component.js";
import {
  expandedLines,
  formatElapsed,
  formatToolUseLine,
  orderAsTree,
  plural,
} from "./format-helpers.js";
import { formatRunSessionLine, formatSessionIdentityLine } from "./session-lines.js";
import {
  type AgentListingEntry,
  type BackgroundSpawnHandle,
  type RemoveSummary,
  type SubagentDetails,
} from "./details.js";

const DEFAULT_DISPLAY = DEFAULT_SUBAGENT_SETTINGS.display;

export function formatSubagentToolLines(
  details: SubagentDetails,
  expanded = false,
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): string[] {
  return (formatSubagentToolDisplayLines(details, expanded, now, undefined, display) ?? []).map(line => line.text);
}

/**
 * Live summary of a `run` view, shared from the result renderer to the call-title renderer.
 * `elapsed` is wall-clock time since the parent run started, not summed child runtime.
 */
export interface RunSummary {
  running: number;
  queued: number;
  finished: number;
  elapsed: string;
}

/**
 * Derives a {@link RunSummary} from `run` or `results` details, or `undefined` for any other
 * view. The shared count powers both the live run title and the completed/results header. A `run`
 * counts its `subtree` when present (so nested children are included), otherwise the flat
 * `sessions`; a `results` envelope counts each entry's snapshot, plus any bad-id entries (which are
 * terminal) among finished. Every non-`running`/`queued` status is terminal, so it counts as
 * finished. New live `run` details carry `runStartedAt`; otherwise elapsed runs from the earliest
 * row time.
 */
export function runSummary(details: SubagentDetails, now = Date.now()): RunSummary | undefined {
  if (details.view === "run") {
    const sessions = details.subtree && details.subtree.length > 0 ? details.subtree : details.sessions;
    return summarizeSnapshots(sessions, details.runStartedAt, now);
  }
  if (details.view === "results") {
    const roots = details.results.flatMap(entry => ("snapshot" in entry ? [entry.snapshot] : []));
    const byId = new Map<string, AgentSnapshot>();
    for (const root of roots) {
      byId.set(root.id, root);
      for (const subagent of root.subagents ?? []) byId.set(subagent.id, subagent);
    }
    const snapshots = Array.from(byId.values());
    // A settled run has no more "now" to measure against, so freeze the header elapsed at the last
    // completion; a background poll still carrying active entries keeps tracking wall-clock time.
    const summary = summarizeSnapshots(snapshots, undefined, resultsUpperBound(snapshots, now));
    summary.finished += details.results.length - roots.length;
    return summary;
  }
  return undefined;
}

function resultsUpperBound(snapshots: readonly AgentSnapshot[], now: number): number {
  let latest = 0;
  for (const snapshot of snapshots) {
    const status = effectiveStatus(snapshot.status);
    if (status === "running" || status === "queued") return now;
    const completedAt = getCompletedAt(snapshot.status);
    if (completedAt !== undefined && completedAt > latest) latest = completedAt;
  }
  return latest > 0 ? latest : now;
}

function summarizeSnapshots(sessions: readonly AgentSnapshot[], runStartedAt: number | undefined, now: number): RunSummary {
  let running = 0;
  let queued = 0;
  let finished = 0;
  let earliest = now;
  for (const session of sessions) {
    const status = effectiveStatus(session.status);
    if (status === "running") running++;
    else if (status === "queued") queued++;
    else finished++;
    const start = getQueuedAt(session.status) ?? getStartedAt(session.status) ?? session.createdAt;
    if (start < earliest) earliest = start;
  }
  return { running, queued, finished, elapsed: formatElapsed(runStartedAt ?? earliest, now) };
}

export function createSubagentTextComponent(
  details: SubagentDetails,
  expanded: boolean,
  theme: Theme | undefined,
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): Component | undefined {
  // Probe the theme eagerly so a broken theme throws here and renderResult can fall back to plain text.
  if (theme?.fg) theme.fg("muted", "");
  const lines = formatSubagentToolDisplayLines(details, expanded, now, theme?.bold, display);
  return lines ? new SubagentTextComponent(lines, theme) : undefined;
}

function formatSubagentToolDisplayLines(
  details: SubagentDetails,
  expanded = false,
  now = Date.now(),
  bold: Bold | undefined,
  display: SubagentDisplaySettings,
): DisplayLine[] | undefined {
  if (details.view === "error") return undefined;

  switch (details.view) {
    case "agents":
      return formatAgentListLines(details.agents, expanded, bold, display).map(text => ({ text }));
    case "results":
      return formatResultsLines(details.results, expanded, now, bold, display);
    case "run": {
      const ordered = details.subtree && details.subtree.length > 0
        ? orderAsTree(details.subtree)
        : details.sessions.map(agent => ({ agent, depth: 0 }));
      if (!expanded) return expandRows(ordered, false, now, bold, display, runRow, true, true);
      return formatExpandedRunLines(details.sessions, details.subtree ?? [], now, bold, display);
    }
    case "inventory": {
      const { sessions } = details;
      if (sessions.length === 0) return [{ text: "No subagent sessions." }];
      return formatInventoryLines(orderAsTree(sessions), expanded, now, bold);
    }
    case "remove-summary":
      return formatRemoveSummaryLines(details.summary, expanded);
    case "background-started":
      return formatBackgroundStartedLines(details.handles, details.count, expanded, bold);
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
  headColor?: ThemeColor;
  expanded: boolean;
  entries?: readonly T[];
  renderEntry?: (entry: T) => DisplayLine[];
  blankBetween?: boolean;
  trailer?: DisplayLine[];
}

function renderCountSummary<T>(spec: CountSummarySpec<T>): DisplayLine[] {
  const head: DisplayLine = {
    text: [spec.total, ...spec.counts, ...(spec.trailing ?? [])].join(" · "),
    ...(spec.headColor ? { color: spec.headColor } : {}),
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

type RowRenderer = (row: AgentSnapshot, now: number, bold: Bold | undefined, display: SubagentDisplaySettings) => DisplayLine;

const runRow: RowRenderer = (row, now, bold) => formatRunSessionLine(row, now, bold);

function formatExpandedRunLines(
  roots: readonly AgentSnapshot[],
  subtree: readonly AgentSnapshot[],
  now: number,
  bold: Bold | undefined,
  display: SubagentDisplaySettings,
): DisplayLine[] {
  const byId = new Map(subtree.map(agent => [agent.id, agent]));
  const descendantsOf = (rootId: string) => subtree.filter(agent => {
    let parentId = agent.parentSessionId;
    while (parentId !== undefined) {
      if (parentId === rootId) return true;
      parentId = byId.get(parentId)?.parentSessionId;
    }
    return false;
  });

  return roots.flatMap((root, index) => {
    const subagents = descendantsOf(root.id);
    const row = subagents.length ? { ...root, subagents } : root;
    return expandedLines(
      formatRunSessionLine(row, now, bold),
      row,
      true,
      index < roots.length - 1,
      display,
      now,
      true,
    );
  });
}

/** Inventory and results share the same icon-bearing identity row; expansion adds metadata only. */
function formatInventoryLines(
  ordered: Array<{ agent: AgentSnapshot; depth: number }>,
  expanded: boolean,
  now: number,
  bold: Bold | undefined,
): DisplayLine[] {
  return ordered.flatMap((entry, index) => {
    const indent = "  ".repeat(entry.depth);
    const head = formatSessionIdentityLine(entry.agent, now, bold, true);
    const row: DisplayLine = entry.depth === 0
      ? head
      : {
          ...head,
          text: `${indent}${head.text}`,
          ...(head.segments ? { segments: [{ text: indent }, ...head.segments] } : {}),
        };
    if (!expanded) return [row];

    const metadataIndent = "  ".repeat(entry.depth + 2);
    const lines: DisplayLine[] = [
      row,
      { text: `${metadataIndent}session:${entry.agent.id}`, color: "muted", hangingIndent: metadataIndent.length },
      { text: `${metadataIndent}dispatch:${entry.agent.attempt.dispatch}`, color: "muted", hangingIndent: metadataIndent.length },
      ...(entry.agent.parentSessionId
        ? [{ text: `${metadataIndent}parent:${entry.agent.parentSessionId}`, color: "muted" as const, hangingIndent: metadataIndent.length }]
        : []),
      { text: `${metadataIndent}retained:${entry.agent.retention.catalog === "persistent"}`, color: "muted", hangingIndent: metadataIndent.length },
    ];
    if (index < ordered.length - 1) lines.push({ text: "" });
    return lines;
  });
}

/**
 * The tree path used by collapsed `run` rows. Rows are depth-indented and active agents carry
 * their three most recent tool calls plus an additional-call count. Expanded runs use the
 * root-oriented labeled-section renderer so descendants can appear as compact summary rows.
 */
function expandRows(
  ordered: Array<{ agent: AgentSnapshot; depth: number }>,
  expanded: boolean,
  now: number,
  bold: Bold | undefined,
  display: SubagentDisplaySettings,
  renderRow: RowRenderer,
  includeSnippet: boolean,
  richToolHistory = false,
): DisplayLine[] {
  const layoutAt = (index: number) => runTreeLayout(
    ordered[index].depth,
    (ordered[index + 1]?.depth ?? -1) > ordered[index].depth,
  );
  const withIndent = (entry: { agent: AgentSnapshot; depth: number }, layout: RunTreeLayout): DisplayLine => {
    const line = renderRow(entry.agent, now, bold, display);
    if (!richToolHistory) {
      return entry.depth > 0 ? { ...line, text: `${"  ".repeat(entry.depth)}${line.text}` } : line;
    }
    if (entry.depth === 0) return line;
    return {
      ...line,
      text: `${layout.agentPrefix}${line.text.slice(2)}`,
      ...(line.segments ? { segments: [{ text: layout.agentPrefix }, ...line.segments.slice(1)] } : {}),
    };
  };
  if (!expanded) {
    return ordered.flatMap((entry, index) => {
      const layout = layoutAt(index);
      return [
        withIndent(entry, layout),
        ...(richToolHistory ? recentToolLines(entry.agent, now, display, layout) : []),
      ];
    });
  }
  return ordered.flatMap((entry, index) => {
    const layout = layoutAt(index);
    return expandedLines(withIndent(entry, layout), entry.agent, includeSnippet, index < ordered.length - 1, display, now, richToolHistory);
  });
}

interface RunTreeLayout {
  agentPrefix: string;
  toolPrefix: string;
  overflowPrefix: string;
  railPrefix?: string;
}

/** Keeps nested connectors and tool details aligned from one canonical agent-row prefix. */
function runTreeLayout(depth: number, hasNestedChild: boolean): RunTreeLayout {
  const agentPrefix = depth === 0 ? "  " : `${"  ".repeat(depth)}╰─ `;
  const toolColumn = agentPrefix.length + 2; // status glyph + following space
  const detailPrefix = new Array<string>(toolColumn).fill(" ");
  const railColumn = (depth + 1) * 2;
  if (hasNestedChild) detailPrefix[railColumn] = "│";
  const overflowPrefix = detailPrefix.join("");
  return {
    agentPrefix,
    toolPrefix: `${overflowPrefix}╰ `,
    overflowPrefix,
    ...(hasNestedChild ? { railPrefix: overflowPrefix.slice(0, railColumn + 1) } : {}),
  };
}

/**
 * Collapsed recent-tool lines for a live run row. A finished subagent collapses to just its row —
 * its results state — even while sibling subagents keep running, so only an active agent surfaces
 * tools. When a nested subagent is still running, surface only the nested run(s) — not the parent's
 * other tools — so the in-flight nested progress stays visible. Otherwise show the most recent
 * calls newest-first, capped at three, with a trailing line counting any further calls.
 */
function recentToolLines(
  agent: AgentSnapshot,
  now: number,
  display: SubagentDisplaySettings,
  layout: RunTreeLayout,
): DisplayLine[] {
  if (!isActiveStatusKind(effectiveStatus(agent.status))) return [];
  const history = agent.activity.toolHistory;
  const max = display.toolInputSummaryLength;
  const withRailColor = (text: string, color: ThemeColor | undefined, hangingIndent: number): DisplayLine => ({
    text,
    color,
    hangingIndent,
    ...(layout.railPrefix ? { segments: [
      { text: layout.railPrefix, color: "text" },
      { text: text.slice(layout.railPrefix.length), ...(color ? { color } : {}) },
    ] } : {}),
  });
  const formatTool = (tool: AgentSnapshot["activity"]["toolHistory"][number]): DisplayLine => {
    const line = formatToolUseLine(tool, 0, now, max);
    return withRailColor(`${layout.toolPrefix}${line.text}`, line.color, layout.toolPrefix.length);
  };
  const runningSubagents = history.filter(tool => tool.name === "subagent" && tool.completedAt === undefined);
  if (runningSubagents.length > 0) return runningSubagents.slice().reverse().map(formatTool);

  const recent = history.slice(-3).reverse();
  const lines = recent.map(formatTool);
  const extra = history.length - recent.length;
  if (extra > 0) {
    lines.push(withRailColor(
      `${layout.overflowPrefix}+${extra} additional tool call${extra === 1 ? "" : "s"}`,
      "muted",
      layout.overflowPrefix.length,
    ));
  }
  return lines;
}

/**
 * The completed/`results` view, rendered to mirror the live `run` view (your changes 3 & 4): the
 * header is the tool-call title line, and the body is one run-style row per entry — collapsed shows
 * just the rows (no per-row tool lines), expanded reuses {@link expandedLines} so each entry adds
 * labeled task, previous-run, recent-tool, subagent, and answer sections. The same renderer
 * serves the explicit `results` action and background polls, so pending and bad-id entries appear
 * here too.
 */
function formatResultsLines(entries: readonly ResultEntry[], expanded: boolean, now: number, bold: Bold | undefined, display: SubagentDisplaySettings): DisplayLine[] {
  if (!expanded) return entries.map(entry => resultRow(entry, now, bold, display));
  return entries.flatMap((entry, index) => resultExpanded(entry, index < entries.length - 1, now, bold, display));
}

/** One collapsed result row, using the same shape for pending and terminal snapshots. */
function resultRow(entry: ResultEntry, now: number, bold: Bold | undefined, _display: SubagentDisplaySettings): DisplayLine {
  if ("error" in entry) return { text: `${entry.sessionId} · error: ${entry.error}`, color: "error" };
  return formatRunSessionLine(entry.snapshot, now, bold, true);
}

/**
 * One expanded result entry. Snapshot entries render through the same {@link expandedLines} path as
 * the live run — labeled compact sections and retained subagent summaries — plus its terminal
 * answer snippet. Bad-id entries collapse to a single error line.
 */
function resultExpanded(entry: ResultEntry, trailingBlank: boolean, now: number, bold: Bold | undefined, display: SubagentDisplaySettings): DisplayLine[] {
  if ("error" in entry) {
    const line: DisplayLine = { text: `${entry.sessionId} · error: ${entry.error}`, color: "error" };
    return trailingBlank ? [line, { text: "" }] : [line];
  }
  const row = formatRunSessionLine(entry.snapshot, now, bold, true);
  return expandedLines(row, entry.snapshot, true, trailingBlank, display, now, true);
}

function formatBackgroundStartedLines(handles: BackgroundSpawnHandle[], count: number, expanded: boolean, bold?: Bold): DisplayLine[] {
  return renderCountSummary({
    total: `${plural(count, "background subagent")} started`,
    counts: [],
    expanded,
    entries: handles,
    renderEntry: handle => [{
      text: `  ${applyBold(bold, handle.agent)}${handle.label ? `  ${handle.label}` : ""} · ${handle.sessionId}`,
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
      ? [{ text: "" }, { text: "Errors:" }, ...errors.map(entry => ({ text: `  ${entry.sessionId}: ${entry.error}`, color: "error" as const }))]
      : undefined,
  });
}

function formatAgentListLines(agents: AgentListingEntry[], expanded: boolean, bold: Bold | undefined, display: SubagentDisplaySettings = DEFAULT_DISPLAY): string[] {
  if (!expanded) {
    return agents.slice(0, display.collapsedAgentListLimit).map(agent => `${applyBold(bold, agent.name)} · ${compact(agent.description, display.collapsedDescriptionLength)}`);
  }

  return agents.flatMap((agent, index) => {
    const configuration = [
      `Source: ${agent.source}`,
      `Model: ${agent.model ?? "default"} · thinking:${agent.thinking ?? "default"}`,
      `Retain conversation: ${agent.retainConversation}`,
      `Tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}`,
      `Skills: ${agent.skills?.length ? agent.skills.join(", ") : "none"}`,
      ...(agent.sourcePath ? [`Path: ${agent.sourcePath}`] : []),
    ];
    const lines = [
      applyBold(bold, agent.name),
      ...agent.description.split(/\r?\n/).map(line => `  ${line}`),
      ...configuration.map(line => `  ${line}`),
    ];
    if (index < agents.length - 1) lines.push("");
    return lines;
  });
}
