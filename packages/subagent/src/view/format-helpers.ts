import type { Usage } from "@earendil-works/pi-ai";

import type { AgentRunSection, AgentSnapshot, AgentToolUse, AgentViewStatus } from "../domain/agent-snapshot.js";
import {
  effectiveStatus,
  getCompletedAt,
  getQueuedAt,
  getSnippet,
  getStartedAt,
} from "../domain/agent-decisions.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../config/settings.js";
import { compact, compactMultiline } from "./view-helpers.js";
import type { DisplayLine } from "./text-component.js";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

const DEFAULT_DISPLAY = DEFAULT_SUBAGENT_SETTINGS.display;

const RUNNING_GLYPHS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUNNING_GLYPH_INTERVAL_MS = 120;

type StatusPresentation = { glyph: string; color: ThemeColor };

const STATUS_PRESENTATION: Record<string, StatusPresentation> = {
  completed: { glyph: "✓", color: "success" },
  running: { glyph: RUNNING_GLYPHS[0], color: "accent" },
  queued: { glyph: "○", color: "muted" },
  error: { glyph: "✗", color: "error" },
};
const FALLBACK_STATUS_PRESENTATION: StatusPresentation = { glyph: "!", color: "warning" };

export function statusPresentation(status: AgentViewStatus, now = Date.now()): StatusPresentation {
  const effective = effectiveStatus(status);
  if (effective === "running") {
    const frame = Math.floor(now / RUNNING_GLYPH_INTERVAL_MS) % RUNNING_GLYPHS.length;
    return { glyph: RUNNING_GLYPHS[frame], color: "accent" };
  }
  return STATUS_PRESENTATION[effective] ?? FALLBACK_STATUS_PRESENTATION;
}

export function statusColorForOutcome(status: string): ThemeColor {
  if (status === "completed") return "success";
  if (status === "error") return "error";
  if (status === "running") return "accent";
  if (status === "queued") return "muted";
  return "warning";
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function rowElapsed(row: AgentSnapshot, now: number): string {
  return formatElapsed(getStartedAt(row.status) ?? getQueuedAt(row.status) ?? row.createdAt, getCompletedAt(row.status) ?? now);
}

export function formatElapsed(from: number, to: number) {
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

export function formatToolUseLine(tool: AgentToolUse, indent: number, now = Date.now(), summaryMaxLength = DEFAULT_DISPLAY.toolInputSummaryLength): DisplayLine {
  const completed = tool.completedAt !== undefined;
  const color = tool.isError ? "error" : completed ? "muted" : "accent";
  const glyph = tool.isError ? "✗" : completed ? "✓" : statusPresentation({ kind: "running", startedAt: tool.startedAt }, now).glyph;
  const elapsed = formatElapsed(tool.startedAt, tool.completedAt ?? now);
  const summary = tool.inputSummary ? ` ${compact(tool.inputSummary, summaryMaxLength)}` : "";
  return {
    text: `${" ".repeat(indent)}${glyph} ${tool.name}${summary} · ${elapsed}`,
    color,
    hangingIndent: indent,
  };
}

export function formatTimestamp(value: number) {
  return new Date(value).toISOString();
}

export function formatUsage(usage: Usage) {
  const tokens = `${usage.totalTokens} tokens`;
  const cost = usage.cost?.total ? ` · $${usage.cost.total.toFixed(4)}` : "";
  return `${tokens}${cost}`;
}

export function orderAsTree(sessions: readonly AgentSnapshot[]): Array<{ agent: AgentSnapshot; depth: number }> {
  const presentIds = new Set(sessions.map(s => s.id));
  const rootKey = "";
  const childrenByParent = new Map<string, AgentSnapshot[]>();
  for (const session of sessions) {
    const parentKey = session.parentSessionId && presentIds.has(session.parentSessionId) ? session.parentSessionId : rootKey;
    const bucket = childrenByParent.get(parentKey);
    if (bucket) bucket.push(session);
    else childrenByParent.set(parentKey, [session]);
  }
  for (const [parentKey, bucket] of childrenByParent) {
    if (parentKey !== rootKey) bucket.sort((a, b) => a.createdAt - b.createdAt);
  }

  const out: Array<{ agent: AgentSnapshot; depth: number }> = [];
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

export function snippetLines(snippet: string, leadingIndent: number, color: ThemeColor | undefined, display: SubagentDisplaySettings = DEFAULT_DISPLAY): DisplayLine[] {
  const compacted = compactMultiline(snippet, display.outputSnippetLength, display.outputSnippetMaxLines);
  const lead = " ".repeat(leadingIndent);
  const [first, ...rest] = compacted.split("\n");
  const head: DisplayLine = { text: `${lead}${first}`, color, hangingIndent: leadingIndent };
  return [head, ...rest.map(line => ({ text: `${lead}${line}`, color, hangingIndent: leadingIndent }))];
}

/**
 * The prompt/tools/output-or-error shape shared by both the current run and each previous run
 * section of a resumed agent. {@link AgentSnapshot} and {@link AgentRunSection} both satisfy it.
 */
type RunBody = Pick<AgentSnapshot, "prompt" | "activity" | "status">;

export function expandedLines(
  head: DisplayLine,
  row: AgentSnapshot,
  includeSnippet: boolean,
  trailingBlank: boolean,
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
  now = Date.now(),
  richToolHistory = false,
): DisplayLine[] {
  const lines = [head];
  // Previous runs only surface in the rich (run-view) expansion, above the current run.
  if (richToolHistory && row.previousRuns?.length) appendPreviousRuns(lines, row.previousRuns, display, now);
  appendPrompt(lines, row);
  if (richToolHistory) appendToolHistory(lines, row, now, display);
  else appendToolCounts(lines, row);
  if (includeSnippet) appendSnippet(lines, row, display);
  if (trailingBlank) lines.push({ text: "" });
  return lines;
}

function appendPreviousRuns(lines: DisplayLine[], sections: readonly AgentRunSection[], display: SubagentDisplaySettings, now: number) {
  sections.forEach((section, index) => {
    lines.push({ text: "" });
    lines.push(previousRunHeader(section, index, now));
    appendPrompt(lines, section);
    appendToolHistory(lines, section, now, display);
    appendSnippet(lines, section, display);
  });
}

function previousRunHeader(section: AgentRunSection, index: number, now: number): DisplayLine {
  const elapsed = sectionElapsed(section, now);
  const parts = [`Previous run ${index + 1}`, effectiveStatus(section.status), ...(elapsed ? [elapsed] : [])];
  return { text: `    ${parts.join(" · ")}`, color: statusPresentation(section.status, now).color, hangingIndent: 4 };
}

function sectionElapsed(section: AgentRunSection, now: number): string | undefined {
  const startedAt = getStartedAt(section.status) ?? getQueuedAt(section.status);
  if (startedAt === undefined) return undefined;
  return formatElapsed(startedAt, getCompletedAt(section.status) ?? now);
}

function appendSnippet(lines: DisplayLine[], row: RunBody, display: SubagentDisplaySettings) {
  const snippet = getSnippet(row.status);
  if (!snippet) return;
  lines.push({ text: "" });
  lines.push(...snippetLines(snippet, 4, statusPresentation(row.status).color, display));
}

function appendPrompt(lines: DisplayLine[], row: RunBody) {
  if (!row.prompt) return;
  lines.push({ text: "" });
  for (const part of [...row.prompt.split(/\r?\n/), ""]) {
    lines.push({ text: `    ${part}`, color: "accent", hangingIndent: 4 });
  }
}

function appendToolHistory(lines: DisplayLine[], row: RunBody, now: number, display: SubagentDisplaySettings) {
  const history = row.activity.toolHistory;
  if (history.length === 0) return;
  for (const tool of history) lines.push(formatToolUseLine(tool, 4, now, display.toolInputSummaryLength));
}

function appendToolCounts(lines: DisplayLine[], row: AgentSnapshot) {
  const counts = aggregateToolCounts(row.activity.toolHistory);
  if (counts.length === 0) return;
  const summary = counts.map(({ name, count }) => `${name} ×${count}`).join(", ");
  lines.push({ text: "" });
  lines.push({ text: `    Tools: ${summary}`, hangingIndent: 4 });
}

function aggregateToolCounts(
  history: AgentSnapshot["activity"]["toolHistory"],
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const tool of history) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
