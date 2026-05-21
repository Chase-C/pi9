import type { Usage } from "@earendil-works/pi-ai";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentGroupView, AgentRunStatus, AgentView, AgentViewStatus } from "../domain/agent-view.js";
import type { BackgroundResult } from "../runtime/agent-manager.js";
import { serializeGroup } from "./serialize.js";
import {
  getSubagentDisplaySettings,
  compact,
  effectiveStatus,
  getActiveTools,
  getCompletedAt,
  getSnippet,
  getSnippetLabel,
  getQueuedAt,
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

export type RemoveSummary = {
  removed: number;
  aborted: number;
  sessionIds: string[];
  errors?: Array<{ sessionId: string; error: string }>;
};

export type InventoryFilter = { status?: string[] };

export type BackgroundSpawnHandle = {
  sessionId: string;
  inputIndex: number;
  label?: string;
};

export type RunOutcome = {
  inputIndex: number;
  agent: string;
  status: AgentRunStatus;
  label?: string;
  sessionId?: string;
  output?: string;
  error?: string;
  resumed?: boolean;
};

export type SubagentDetails =
  | { view: "agents"; agents: AgentListingEntry[] }
  | { view: "run"; group: AgentGroupView; active?: boolean; subtree?: AgentView[] }
  | { view: "run-results"; outcomes: RunOutcome[]; isError: boolean }
  | { view: "inventory"; sessions: AgentView[]; filter?: InventoryFilter }
  | { view: "remove-summary"; summary: RemoveSummary }
  | { view: "background-started"; handles: BackgroundSpawnHandle[]; count: number; background: true }
  | { view: "background-results"; results: BackgroundResult[] };

export type AgentsDetails = Extract<SubagentDetails, { view: "agents" }>;
export type RunDetails = Extract<SubagentDetails, { view: "run" }>;
export type RunResultsDetails = Extract<SubagentDetails, { view: "run-results" }>;
export type InventoryDetails = Extract<SubagentDetails, { view: "inventory" }>;
export type RemoveSummaryDetails = Extract<SubagentDetails, { view: "remove-summary" }>;
export type BackgroundStartedDetails = Extract<SubagentDetails, { view: "background-started" }>;
export type BackgroundResultsDetails = Extract<SubagentDetails, { view: "background-results" }>;

export function agentsDetails(agents: AgentListingEntry[]): AgentsDetails {
  return { view: "agents", agents };
}

export function runDetails(
  group: AgentGroupView,
  extras: { active?: boolean; subtree?: AgentView[] } = {},
): RunDetails {
  return { view: "run", group, ...extras };
}

export function runResultsDetails(outcomes: RunOutcome[], isError: boolean): RunResultsDetails {
  return { view: "run-results", outcomes, isError };
}

export function inventoryDetails(sessions: AgentView[], filter?: InventoryFilter): InventoryDetails {
  return { view: "inventory", sessions, ...(filter ? { filter } : {}) };
}

export function backgroundStartedDetails(sessions: AgentView[]): BackgroundStartedDetails {
  const handles: BackgroundSpawnHandle[] = sessions.flatMap((session, index) => {
    if (session.retention !== "persistent") return [];
    return [{
      sessionId: session.id,
      inputIndex: session.inputIndex ?? index,
      ...(session.label !== undefined ? { label: session.label } : {}),
    }];
  });
  return { view: "background-started", handles, count: sessions.length, background: true };
}

export function backgroundResultsDetails(results: BackgroundResult[]): BackgroundResultsDetails {
  return { view: "background-results", results };
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
    agent.dispatch === "background" ? "dispatch:background" : undefined,
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
  if (agent.activity.messageSnippet) lines.push(`Message: ${compact(agent.activity.messageSnippet, getSubagentDisplaySettings().messageSnippetLength)}`);

  const actions = ["inspect"];
  if (agent.capabilities.canResume) actions.push("resume");
  if (agent.capabilities.canClear) actions.push("remove");
  lines.push(`Actions: ${actions.join(", ")}`);
  return lines;
}

export function formatWidgetLines(agents: AgentView[], now = Date.now()): string[] {
  const settings = getSubagentDisplaySettings();
  const visible = agents.filter(a => isActiveStatusKind(a.status.kind) || (settings.widgetShowRetainedSessions && a.retention === "persistent"));
  return orderAsTree(visible).map(({ agent, depth }) => `${"  ".repeat(depth)}${formatSessionLine(agent, now)}`);
}

function orderAsTree(sessions: readonly AgentView[]): Array<{ agent: AgentView; depth: number }> {
  const presentIds = new Set(sessions.map(s => s.id));
  const rootKey = "";
  const childrenByParent = new Map<string, AgentView[]>();
  for (const session of sessions) {
    const parentKey = session.parentSessionId && presentIds.has(session.parentSessionId) ? session.parentSessionId : rootKey;
    const bucket = childrenByParent.get(parentKey);
    if (bucket) bucket.push(session);
    else childrenByParent.set(parentKey, [session]);
  }
  for (const [parentKey, bucket] of childrenByParent) {
    if (parentKey !== rootKey) bucket.sort((a, b) => a.createdAt - b.createdAt);
  }

  const out: Array<{ agent: AgentView; depth: number }> = [];
  const visit = (parentKey: string, depth: number) => {
    const children = childrenByParent.get(parentKey);
    if (!children) return;
    for (const child of children) {
      out.push({ agent: child, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(rootKey, 0);
  return out;
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

    case "run-results":
      return formatRunResultsLines(narrowed.outcomes, expanded, bold);

    case "run": {
      if (narrowed.subtree && narrowed.subtree.length > 0) {
        const ordered = orderAsTree(narrowed.subtree);
        const indent = (depth: number, line: DisplayLine): DisplayLine => ({
          ...line,
          text: `${"  ".repeat(depth)}${line.text}`,
        });
        if (!expanded) {
          return ordered.map(({ agent: row, depth }) => indent(depth, formatRunSessionLine(row, now, bold)));
        }
        return ordered.flatMap(({ agent: row, depth }, index) =>
          expandedLines(indent(depth, formatRunSessionLine(row, now, bold)), row, true, index < ordered.length - 1));
      }
      const { sessions } = narrowed.group;
      if (!expanded) return sessions.map(row => formatRunSessionLine(row, now, bold));
      return sessions.flatMap((row, index) =>
        expandedLines(formatRunSessionLine(row, now, bold), row, true, index < sessions.length - 1));
    }

    case "inventory": {
      const { sessions, filter } = narrowed;
      if (sessions.length === 0) return [{ text: "No subagent sessions." }];
      if (!expanded && sessions.length > 1) {
        return [formatViewGroupLine(serializeGroup(sessions), filter)];
      }
      const ordered = orderAsTree(sessions);
      return expanded
        ? ordered.flatMap(({ agent: row, depth }, index) => expandedLines(
            { text: `${"  ".repeat(depth)}${formatSessionLine(row, now, bold)}`, status: statusPresentation(row.status).color },
            row,
            false,
            index < ordered.length - 1,
          ))
        : ordered.map(({ agent: row, depth }) => ({ text: `${"  ".repeat(depth)}${formatSessionLine(row, now, bold)}`, status: statusPresentation(row.status).color }));
    }

    case "remove-summary":
      return formatRemoveSummaryLines(narrowed.summary, expanded);

    case "background-started":
      return formatBackgroundStartedLines(narrowed.handles, narrowed.count, expanded, bold);

    case "background-results":
      return formatBackgroundResultsLines(narrowed.results, expanded, bold);
  }
}

function formatRunResultsLines(outcomes: RunOutcome[], expanded: boolean, bold?: Bold): DisplayLine[] {
  const counts = new Map<AgentRunStatus, number>();
  for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
  const ordered: AgentRunStatus[] = ["completed", "error", "aborted", "interrupted", "skipped"];
  const segments = [plural(outcomes.length, "subagent")];
  for (const status of ordered) {
    const count = counts.get(status);
    if (count) segments.push(`${count} ${status}`);
  }
  const head: DisplayLine = {
    text: segments.join(" · "),
    status: outcomes.some(o => o.status !== "completed") ? "error" : "completed",
  };
  if (!expanded) return [head];

  const lines: DisplayLine[] = [head];
  for (const outcome of outcomes) {
    lines.push({ text: "" });
    const color = statusColorForOutcome(outcome.status);
    const labelSegment = outcome.label ? `  ${outcome.label}` : "";
    const sessionSegment = outcome.sessionId ? ` · session:${outcome.sessionId}` : "";
    const resumedSegment = outcome.resumed ? " · resumed" : "";
    lines.push({
      text: `${applyBold(bold, outcome.agent)}${labelSegment} · ${outcome.status}${sessionSegment}${resumedSegment}`,
      status: color,
    });
    const snippet = outcome.status === "completed" ? outcome.output : outcome.error;
    if (snippet) {
      const snippetLabel = outcome.status === "completed" ? "Result" : "Error";
      lines.push(...snippetLines(snippetLabel, snippet, 2, color));
    }
  }
  return lines;
}

function formatBackgroundResultsLines(results: BackgroundResult[], expanded: boolean, bold?: Bold): DisplayLine[] {
  let ready = 0;
  let notReady = 0;
  let errors = 0;
  for (const entry of results) {
    if ("error" in entry) errors += 1;
    else if (entry.ready) ready += 1;
    else notReady += 1;
  }
  const segments = [plural(results.length, "result")];
  if (ready > 0) segments.push(`${ready} ready`);
  if (notReady > 0) segments.push(`${notReady} not ready`);
  if (errors > 0) segments.push(plural(errors, "error"));
  const head: DisplayLine = { text: segments.join(" · ") };
  if (!expanded) return [head];

  const lines: DisplayLine[] = [head];
  for (const entry of results) {
    lines.push({ text: "" });
    if ("error" in entry) {
      lines.push({ text: `${entry.sessionId} · error: ${entry.error}`, status: "error" });
    } else if (entry.ready) {
      const result = entry.result;
      const color = statusColorForOutcome(result.status);
      const labelSegment = result.label ? `  ${result.label}` : "";
      lines.push({
        text: [`${applyBold(bold, result.agent)}${labelSegment}`, result.status, `session:${entry.sessionId}`].join(" · "),
        status: color,
      });
      const snippet = result.status === "completed" ? result.output : result.error ?? result.status;
      if (snippet) {
        const snippetLabel = result.status === "completed" ? "Result" : "Error";
        lines.push(...snippetLines(snippetLabel, snippet, 2, color));
      }
    } else {
      const labelSegment = entry.label ? `  ${entry.label}` : "";
      lines.push({
        text: `${applyBold(bold, entry.agent)}${labelSegment} · ${entry.status} · ${formatElapsed(0, entry.elapsedMs)}`,
        status: entry.status,
      });
    }
  }
  return lines;
}

function statusColorForOutcome(status: string): DisplayStatus {
  if (status === "completed") return "completed";
  if (status === "error") return "error";
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  return "warning";
}

function formatBackgroundStartedLines(handles: BackgroundSpawnHandle[], count: number, expanded: boolean, bold?: Bold): DisplayLine[] {
  const head: DisplayLine = { text: `${plural(count, "background subagent")} started` };
  if (!expanded) return [head];
  const lines: DisplayLine[] = [head];
  for (const handle of handles) {
    const label = handle.label ?? handle.sessionId;
    const text = handle.label
      ? `  ${applyBold(bold, label)} · ${handle.sessionId}`
      : `  ${applyBold(bold, handle.sessionId)}`;
    lines.push({ text });
  }
  return lines;
}

function formatRemoveSummaryLines(summary: RemoveSummary, expanded: boolean): DisplayLine[] {
  const errors = summary.errors ?? [];
  const parts = [`Removed ${plural(summary.removed, "session")}`];
  if (summary.aborted > 0) parts.push(`aborted ${summary.aborted}`);
  if (errors.length > 0) parts.push(plural(errors.length, "error"));
  const head: DisplayLine = { text: parts.join(" · ") };
  if (!expanded) return [head];
  const lines: DisplayLine[] = [head];
  for (const id of summary.sessionIds) lines.push({ text: `  ${id}` });
  if (errors.length > 0) {
    lines.push({ text: "" });
    lines.push({ text: "Errors:" });
    for (const entry of errors) lines.push({ text: `  ${entry.sessionId}: ${entry.error}`, status: "error" });
  }
  return lines;
}

function narrowDetails(details: unknown): SubagentDetails | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as { view?: unknown; agents?: unknown; group?: unknown; sessions?: unknown; summary?: unknown };
  switch (record.view) {
    case "agents":
      return Array.isArray(record.agents) ? { view: "agents", agents: record.agents as AgentListingEntry[] } : undefined;
    case "run":
      if (!record.group || typeof record.group !== "object") return undefined;
      return {
        view: "run",
        group: record.group as AgentGroupView,
        ...(Array.isArray((record as { subtree?: unknown }).subtree)
          ? { subtree: (record as { subtree: AgentView[] }).subtree }
          : {}),
      };
    case "run-results": {
      const outcomes = (record as { outcomes?: unknown }).outcomes;
      const isError = (record as { isError?: unknown }).isError;
      if (!Array.isArray(outcomes) || typeof isError !== "boolean") return undefined;
      return { view: "run-results", outcomes: outcomes as RunOutcome[], isError };
    }
    case "inventory":
      return Array.isArray(record.sessions)
        ? {
            view: "inventory",
            sessions: record.sessions as AgentView[],
            ...((record as { filter?: InventoryFilter }).filter ? { filter: (record as { filter?: InventoryFilter }).filter } : {}),
          }
        : undefined;
    case "remove-summary":
      return record.summary && typeof record.summary === "object"
        ? { view: "remove-summary", summary: record.summary as RemoveSummary }
        : undefined;
    case "background-started": {
      const handles = (record as { handles?: unknown }).handles;
      const count = (record as { count?: unknown }).count;
      if (!Array.isArray(handles) || typeof count !== "number") return undefined;
      return { view: "background-started", handles: handles as BackgroundSpawnHandle[], count, background: true };
    }
    case "background-results":
      return Array.isArray((record as { results?: unknown }).results)
        ? { view: "background-results", results: (record as { results: BackgroundResult[] }).results }
        : undefined;
    default:
      return undefined;
  }
}

const ORDERED_GROUP_STATUSES = ["queued", "running", "completed", "error", "interrupted", "skipped", "aborted"];

function formatViewGroupLine(group: AgentGroupView, filter?: InventoryFilter): DisplayLine {
  const known = new Set(ORDERED_GROUP_STATUSES);
  const format = (status: string) => `${group.statusCounts[status]} ${status}`;
  const counts = ORDERED_GROUP_STATUSES.filter(status => group.statusCounts[status]).map(format);
  const extras = Object.keys(group.statusCounts).filter(status => !known.has(status)).sort().map(format);
  const outcome = groupOutcome(group);
  const outcomeLabel = outcome === "queued" ? "running" : outcome;
  const filterSegment = filter?.status && filter.status.length > 0 ? [`filter:${filter.status.join(",")}`] : [];
  return {
    text: [`${group.sessions.length} subagents`, ...counts, ...extras, `outcome:${outcomeLabel}`, ...filterSegment].join(" · "),
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
  if (row.dispatch === "background") parts.push("dispatch:background");

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
  return formatElapsed(getStartedAt(row.status) ?? getQueuedAt(row.status) ?? row.createdAt, getCompletedAt(row.status) ?? now);
}

function formatAgentListLines(agents: AgentListingEntry[], expanded: boolean, bold?: Bold): string[] {
  if (!expanded) {
    const settings = getSubagentDisplaySettings();
    return agents.slice(0, settings.collapsedAgentListLimit).map(agent => `${applyBold(bold, agent.name)} · ${compact(agent.description, settings.collapsedDescriptionLength)}`);
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
