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
import { compactMultiline } from "./view-helpers.js";
import type { DisplayLine, DisplayStatus } from "./text-component.js";

const DEFAULT_DISPLAY = DEFAULT_SUBAGENT_SETTINGS.display;

const RUNNING_GLYPHS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUNNING_GLYPH_INTERVAL_MS = 120;

const STATUS_PRESENTATION: Record<string, { glyph: string; color: DisplayStatus }> = {
  completed: { glyph: "✓", color: "completed" },
  running: { glyph: RUNNING_GLYPHS[0], color: "running" },
  queued: { glyph: "○", color: "queued" },
  error: { glyph: "✗", color: "error" },
};
const FALLBACK_STATUS_PRESENTATION = { glyph: "!", color: "warning" as DisplayStatus };

export function statusPresentation(status: AgentViewStatus, now = Date.now()) {
  const effective = effectiveStatus(status);
  if (effective === "running") {
    const frame = Math.floor(now / RUNNING_GLYPH_INTERVAL_MS) % RUNNING_GLYPHS.length;
    return { glyph: RUNNING_GLYPHS[frame], color: "running" as DisplayStatus };
  }
  return STATUS_PRESENTATION[effective] ?? FALLBACK_STATUS_PRESENTATION;
}

export function statusColorForOutcome(status: string): DisplayStatus {
  if (status === "completed") return "completed";
  if (status === "error") return "error";
  if (status === "running") return "running";
  if (status === "queued") return "queued";
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

export function formatToolUseLine(tool: AgentToolUse, indent: number, now = Date.now()): DisplayLine {
  const completed = tool.completedAt !== undefined;
  const status = tool.isError ? "error" : completed ? "completed" : "running";
  const glyph = tool.isError ? "✗" : completed ? "✓" : statusPresentation({ kind: "running", startedAt: tool.startedAt }, now).glyph;
  const elapsed = formatElapsed(tool.startedAt, tool.completedAt ?? now);
  const summary = tool.inputSummary ? ` ${tool.inputSummary}` : "";
  return {
    text: `${" ".repeat(indent)}${glyph} ${tool.name}${summary} · ${elapsed}`,
    status,
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

export function snippetLines(label: string, snippet: string, leadingIndent: number, color: DisplayStatus | undefined, display: SubagentDisplaySettings = DEFAULT_DISPLAY): DisplayLine[] {
  const compacted = compactMultiline(snippet, display.outputSnippetLength, display.outputSnippetMaxLines);
  const lead = " ".repeat(leadingIndent);
  const continuationIndent = leadingIndent + label.length + 2;
  const continuation = " ".repeat(continuationIndent);
  const [first, ...rest] = compacted.split("\n");
  const head: DisplayLine = { text: `${lead}${label}: ${first}`, status: color, hangingIndent: leadingIndent };
  return [head, ...rest.map(line => ({ text: `${continuation}${line}`, status: color, hangingIndent: continuationIndent }))];
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
  if (richToolHistory) appendToolHistory(lines, row, now);
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
    appendToolHistory(lines, section, now);
    appendSnippet(lines, section, display);
  });
}

function previousRunHeader(section: AgentRunSection, index: number, now: number): DisplayLine {
  const elapsed = sectionElapsed(section, now);
  const parts = [`Previous run ${index + 1}`, effectiveStatus(section.status), ...(elapsed ? [elapsed] : [])];
  return { text: `    ${parts.join(" · ")}`, status: statusPresentation(section.status, now).color, hangingIndent: 4 };
}

function sectionElapsed(section: AgentRunSection, now: number): string | undefined {
  const startedAt = getStartedAt(section.status) ?? getQueuedAt(section.status);
  if (startedAt === undefined) return undefined;
  return formatElapsed(startedAt, getCompletedAt(section.status) ?? now);
}

function appendSnippet(lines: DisplayLine[], row: RunBody, display: SubagentDisplaySettings) {
  const snippet = getSnippet(row.status);
  if (!snippet) return;
  const label = effectiveStatus(row.status) === "completed" ? "Result" : "Error";
  lines.push(...snippetLines(label, snippet, 4, statusPresentation(row.status).color, display));
}

function appendPrompt(lines: DisplayLine[], row: RunBody) {
  if (!row.prompt) return;
  lines.push({ text: "" });
  for (const part of [...row.prompt.split(/\r?\n/), ""]) {
    lines.push({ text: `    ${part}`, hangingIndent: 4 });
  }
}

function appendToolHistory(lines: DisplayLine[], row: RunBody, now: number) {
  const history = row.activity.toolHistory;
  if (history.length === 0) return;
  lines.push({ text: "" });
  lines.push({ text: "    Tools:", hangingIndent: 4 });
  for (const tool of history) lines.push(formatToolUseLine(tool, 6, now));
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
