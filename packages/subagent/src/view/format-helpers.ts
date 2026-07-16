import type { Usage } from "@earendil-works/pi-ai";

import type { AgentRunSection, AgentSnapshot, AgentToolUse, AgentViewStatus } from "../domain/agent-snapshot.js";
import {
  effectiveStatus,
  getCompletedAt,
  getQueuedAt,
  getSnippet,
  getStartedAt,
  getToolUseCount,
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

export function abbreviateTokens(total: number): string | undefined {
  if (total <= 0) return undefined;
  if (total < 1000) return String(total);
  if (total < 10_000) {
    const rounded = Math.round(total / 100) / 10;
    return `${rounded}k`;
  }
  return `${Math.round(total / 1000)}k`;
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
  //const completed = tool.completedAt !== undefined;
  const color = tool.isError ? "error" : "muted";
  //const glyph = tool.isError ? "✗" : completed ? "✓" : statusPresentation({ kind: "running", startedAt: tool.startedAt }, now).glyph;
  const elapsed = formatElapsed(tool.startedAt, tool.completedAt ?? now);
  const summary = tool.inputSummary ? `(${compact(tool.inputSummary, summaryMaxLength)})` : "";
  return {
    text: `${" ".repeat(indent)}${tool.name}${summary} · ${elapsed}`,
    //text: `${" ".repeat(indent)}${glyph} ${tool.name}${summary} · ${elapsed}`,
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
  appendBracket(lines, "Task", promptLines(row.prompt));
  if (richToolHistory) {
    appendPreviousRuns(lines, row.previousRuns ?? [], display, now);
    appendRecentTools(lines, row, now, display);
    appendSubagents(lines, row.subagents ?? [], now);
  }
  if (includeSnippet) appendAnswer(lines, row, display);
  if (trailingBlank) lines.push({ text: "" });
  return lines;
}

function appendBracket(lines: DisplayLine[], label: string, content: DisplayLine[]) {
  if (content.length === 0) return;
  lines.push({ text: `    ┌ ${label}`, color: "muted", hangingIndent: 4 });
  for (const line of content) {
    const contentSegments = line.segments ?? [{ text: line.text, ...(line.color ? { color: line.color } : {}) }];
    lines.push({
      ...line,
      text: `    │ ${line.text}`,
      color: undefined,
      hangingIndent: 6,
      segments: [
        { text: "    " },
        { text: "│", color: "muted" },
        { text: " " },
        ...contentSegments,
      ],
      continuationPrefix: [
        { text: "    " },
        { text: "│", color: "muted" },
        { text: " " },
      ],
    });
  }
  lines.push({ text: "    └", color: "muted", hangingIndent: 4 });
}

function promptLines(prompt: string | undefined): DisplayLine[] {
  if (!prompt) return [];
  return prompt.split(/\r?\n/).map(text => ({ text, color: "text" }));
}

function appendPreviousRuns(
  lines: DisplayLine[],
  sections: readonly AgentRunSection[],
  display: SubagentDisplaySettings,
  now: number,
) {
  sections.forEach((section, index) => {
    const elapsed = sectionElapsed(section, now);
    const label = [
      `Previous Run ${index + 1}`,
      effectiveStatus(section.status),
      ...(elapsed ? [elapsed] : []),
    ].join(" · ");
    const prompt = compactRunLine(section.prompt, display.outputSnippetLength);
    const response = compactRunLine(getSnippet(section.status), display.outputSnippetLength);
    appendBracket(lines, label, [
      ...(prompt ? [{ text: prompt, color: "text" as const, truncate: true }] : []),
      ...(response ? [{ text: response, color: statusPresentation(section.status, now).color, truncate: true }] : []),
    ]);
  });
}

function compactRunLine(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return compact(value, maxLength);
}

function sectionElapsed(section: AgentRunSection, now: number): string | undefined {
  const startedAt = getStartedAt(section.status) ?? getQueuedAt(section.status);
  if (startedAt === undefined) return undefined;
  return formatElapsed(startedAt, getCompletedAt(section.status) ?? now);
}

function appendRecentTools(
  lines: DisplayLine[],
  row: AgentSnapshot,
  now: number,
  display: SubagentDisplaySettings,
) {
  const history = row.activity.toolHistory;
  if (history.length === 0) return;
  const recent = history.slice(-3).reverse();
  const content = recent.map(tool => formatToolUseLine(tool, 0, now, display.toolInputSummaryLength));
  const additional = history.length - recent.length;
  if (additional > 0) {
    content.push({
      text: `+${additional} additional tool call${additional === 1 ? "" : "s"}`,
      color: "muted",
    });
  }
  appendBracket(lines, `Tools · ${plural(history.length, "call")}`, content);
}

function appendSubagents(lines: DisplayLine[], subagents: readonly AgentSnapshot[], now: number) {
  if (subagents.length === 0) return;
  const byId = new Map(subagents.map(agent => [agent.id, agent]));
  const content = subagents.map(agent => {
    let depth = 0;
    let parentId = agent.parentSessionId;
    while (parentId !== undefined && byId.has(parentId)) {
      depth++;
      parentId = byId.get(parentId)?.parentSessionId;
    }
    const { glyph, color } = statusPresentation(agent.status, now);
    const label = agent.label ? `  ${agent.label}` : "";
    const metadata = [
      plural(getToolUseCount(agent), "tool call"),
      plural(agent.usage?.totalTokens ?? 0, "token"),
      formatElapsed(getStartedAt(agent.status) ?? getQueuedAt(agent.status) ?? agent.createdAt, getCompletedAt(agent.status) ?? now),
    ].join(" · ");
    const indent = "  ".repeat(depth);
    return {
      text: `${indent}${glyph} ${agent.config.name}${label}  ${metadata}`,
      hangingIndent: depth * 2,
      segments: [
        { text: indent },
        { text: glyph, color },
        { text: ` ${agent.config.name}${label}`, color: "text" as const },
        { text: `  ${metadata}`, color: "dim" as const },
      ],
    };
  });
  appendBracket(lines, `Subagents · ${subagents.length}`, content);
}

function appendAnswer(lines: DisplayLine[], row: RunBody, display: SubagentDisplaySettings) {
  const snippet = getSnippet(row.status);
  if (!snippet) return;
  appendBracket(lines, "Answer", snippetLines(snippet, 0, statusPresentation(row.status).color, display));
}
