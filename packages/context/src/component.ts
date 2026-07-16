import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextReport, ToolSource } from "./types.js";

export const CONTEXT_REPORT_HELP = "↑↓/jk scroll · PgUp/PgDn or u/d page · Home/End · q/Esc close";

const CHROME_LINES = 3;
const VIEW_HEIGHT_FRACTION = 0.9;
const GRAPH_CELL_GAP = " ";
const GRAPH_GAP = 4;
const STACKED_GRAPH_ROWS = 7;
const GRAPH_STYLE = {
  prompt: { glyph: "●", color: "text" },
  tools: { glyph: "●", color: "warning" },
  memory: { glyph: "●", color: "error" },
  skills: { glyph: "●", color: "success" },
  conversation: { glyph: "◉", color: "accent" },
  other: { glyph: "●", color: "muted" },
  free: { glyph: "○", color: "borderMuted" },
  compaction: { glyph: "●", color: "warning" },
  unknown: { glyph: "●", color: "dim" },
} as const satisfies Record<string, { glyph: string; color: ThemeColor }>;

type TreeBranch = "├" | "└";

interface ContextReportComponentOptions {
  theme: Theme;
  tui: TUI;
  onClose: () => void;
}

interface GraphCategory {
  label: string;
  tokens: number;
  glyph: string;
  color: ThemeColor;
}

interface DetailItem {
  label: string;
  tokens: number;
  meta?: string;
}

export function createContextReportComponent(
  report: ContextReport,
  { theme, tui, onClose }: ContextReportComponentOptions,
): Component {
  let scrollOffset = 0;
  let lastRenderWidth = 80;
  let cachedWidth = -1;
  let cachedLines: string[] = [];

  const syncLines = (width: number): readonly string[] => {
    const contentWidth = reportContentWidth(width);
    if (contentWidth !== cachedWidth) {
      cachedWidth = contentWidth;
      cachedLines = formatContextReportLines(report, theme, contentWidth);
    }
    return cachedLines;
  };

  return {
    invalidate() {
      cachedWidth = -1;
      cachedLines = [];
    },

    handleInput(data: string) {
      const viewport = contentViewportLines(tui.terminal.rows);
      const total = syncLines(lastRenderWidth).length;

      if (
        matchesKey(data, "escape") ||
        matchesKey(data, "q") ||
        matchesKey(data, "enter") ||
        matchesKey(data, "ctrl+c")
      ) {
        onClose();
        return;
      }

      let next = scrollOffset;
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        next = clampScrollOffset(scrollOffset - 1, total, viewport);
      } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
        next = clampScrollOffset(scrollOffset + 1, total, viewport);
      } else if (matchesKey(data, "pageUp") || matchesKey(data, "u")) {
        next = clampScrollOffset(scrollOffset - viewport, total, viewport);
      } else if (matchesKey(data, "pageDown") || matchesKey(data, "d")) {
        next = clampScrollOffset(scrollOffset + viewport, total, viewport);
      } else if (matchesKey(data, "home")) {
        next = 0;
      } else if (matchesKey(data, "end")) {
        next = maxScrollOffset(total, viewport);
      } else {
        return;
      }

      if (next !== scrollOffset) {
        scrollOffset = next;
        tui.requestRender();
      }
    },

    render(width: number): string[] {
      lastRenderWidth = width;
      const displayLines = syncLines(width);
      const viewport = contentViewportLines(tui.terminal.rows);
      scrollOffset = clampScrollOffset(scrollOffset, displayLines.length, viewport);

      if (width < 4) {
        return displayLines
          .slice(scrollOffset, scrollOffset + viewport)
          .map((line) => truncateToWidth(line, Math.max(1, width), ""));
      }

      const innerWidth = width - 2;
      const border = (text: string) => theme.fg("border", text);
      const padLine = (text: string) => {
        const clipped = truncateToWidth(text, innerWidth, "...", true);
        return `${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
      };
      const title = truncateToWidth(" Context Report ", innerWidth);
      const titleWidth = visibleWidth(title);
      const separator = "─".repeat(Math.min(4, Math.max(0, innerWidth - titleWidth)));
      const helpWidth = Math.max(0, innerWidth - titleWidth - separator.length);
      const help = truncateToWidth(` ${CONTEXT_REPORT_HELP} `, helpWidth, "");
      const titlePad = Math.max(0, helpWidth - visibleWidth(help));
      const result = [
        border("╭") + theme.fg("accent", theme.bold(title)) + border(separator) + theme.fg("dim", help) + border(`${"─".repeat(titlePad)}╮`),
      ];

      const visible = displayLines.slice(scrollOffset, scrollOffset + viewport);
      for (const line of visible) {
        result.push(border("│") + padLine(` ${line}`) + border("│"));
      }
      for (let index = visible.length; index < viewport; index += 1) {
        result.push(border("│") + padLine("") + border("│"));
      }

      const maxOffset = maxScrollOffset(displayLines.length, viewport);
      const scrollHint = maxOffset > 0
        ? theme.fg("muted", ` ${scrollOffset + 1}-${scrollOffset + visible.length} of ${displayLines.length}`)
        : "";
      result.push(border("│") + padLine(scrollHint) + border("│"));
      result.push(border(`╰${"─".repeat(innerWidth)}╯`));

      for (const line of result) {
        if (visibleWidth(line) > width) {
          throw new Error(`Rendered line exceeds width ${width}: ${visibleWidth(line)} cols`);
        }
      }

      return result;
    },
  };
}

export function contentViewportLines(terminalRows: number): number {
  const viewRows = Math.floor(terminalRows * VIEW_HEIGHT_FRACTION);
  return Math.max(1, viewRows - CHROME_LINES);
}

export function maxScrollOffset(lineCount: number, viewportLines: number): number {
  return Math.max(0, lineCount - viewportLines);
}

export function clampScrollOffset(offset: number, lineCount: number, viewportLines: number): number {
  return Math.max(0, Math.min(offset, maxScrollOffset(lineCount, viewportLines)));
}

export function formatContextReportLines(report: ContextReport, theme: Theme, width = 80): string[] {
  const lines = ["", ...formatUsageOverview(report, theme, width)];

  if (report.kind === "conversation") {
    pushSection(lines, formatConversationSection(report, theme));
    pushSection(lines, formatDetailSection(
      "Memory files (estimated)",
      report.memory.map((file) => ({ label: file.path, tokens: file.tokens })),
      theme,
    ));
  }

  pushSection(lines, formatToolsSection(report, theme));
  pushSection(lines, formatDetailSection(
    "Skills (estimated)",
    report.skills.map((skill) => ({
      label: skill.name.replace(/^skill:/, ""),
      tokens: skill.descTokens,
      meta: `full ${formatTokens(skill.bodyTokens)} · ${skill.scope}`,
    })),
    theme,
  ));

  return lines;
}

function reportContentWidth(width: number): number {
  return Math.max(1, width - 4);
}

function formatUsageOverview(report: ContextReport, theme: Theme, width: number): string[] {
  const contextWindow = knownTokenValue(report.usage.contextWindow) ?? 0;
  const currentTotal = knownTokenValue(report.usage.tokens);
  const usedCategories = buildGraphCategories(report, currentTotal);
  const knownTokens = sum(usedCategories.map((category) => category.tokens));
  const configuredReserve = report.compaction.enabled
    ? knownTokenValue(report.compaction.reserveTokens) ?? 0
    : 0;
  const occupiedTokens = currentTotal ?? knownTokens;
  const unoccupiedTokens = contextWindow > 0 ? Math.max(0, contextWindow - occupiedTokens) : 0;
  const compactionTokens = Math.min(configuredReserve, unoccupiedTokens);
  const freeTokens = currentTotal !== null ? Math.max(0, unoccupiedTokens - compactionTokens) : 0;
  const unknownTokens = currentTotal === null ? Math.max(0, unoccupiedTokens - compactionTokens) : 0;
  const graphCategories = [
    ...usedCategories,
    ...(freeTokens > 0 ? [{ label: "Free space", tokens: freeTokens, ...GRAPH_STYLE.free }] : []),
    ...(unknownTokens > 0 ? [{ label: "Unknown capacity", tokens: unknownTokens, ...GRAPH_STYLE.unknown }] : []),
    ...(compactionTokens > 0 ? [{ label: "Compaction reserve", tokens: compactionTokens, ...GRAPH_STYLE.compaction }] : []),
  ];
  const totalGraphTokens = contextWindow > 0
    ? contextWindow
    : Math.max(1, sum(graphCategories.map((category) => category.tokens)));
  const visibleGraphCategories = graphCategories.length > 0
    ? graphCategories
    : [{ label: "Free space", tokens: totalGraphTokens, ...GRAPH_STYLE.free }];
  const summaryProbe = formatUsageSummary(
    report,
    usedCategories,
    freeTokens,
    unknownTokens,
    configuredReserve,
    compactionTokens,
    totalGraphTokens,
    theme,
  );
  const summaryWidth = Math.max(...summaryProbe.map(visibleWidth));
  const columns = graphColumnCount(width, summaryWidth);
  const sideBySide = shouldRenderSideBySide(width, columns, summaryWidth);
  const targetRows = sideBySide ? summaryProbe.length : STACKED_GRAPH_ROWS;
  const graphRows = Math.max(targetRows, Math.ceil(visibleGraphCategories.length / columns));
  const cellCount = columns * graphRows;
  const tokensPerCell = totalGraphTokens / cellCount;
  const graphLines = formatGraphGrid(visibleGraphCategories, cellCount, columns, theme);
  const summaryLines = formatUsageSummary(
    report,
    usedCategories,
    freeTokens,
    unknownTokens,
    configuredReserve,
    compactionTokens,
    tokensPerCell,
    theme,
  );

  if (!sideBySide) {
    return [
      ...graphLines,
      "",
      ...summaryLines,
    ];
  }

  const graphWidth = visibleWidth(graphLines[0] ?? "");
  const lines: string[] = [];
  const rows = Math.max(graphLines.length, summaryLines.length);
  for (let index = 0; index < rows; index += 1) {
    lines.push(`${padAnsi(graphLines[index] ?? "", graphWidth)}${" ".repeat(GRAPH_GAP)}${summaryLines[index] ?? ""}`.trimEnd());
  }
  return lines;
}

function formatUsageSummary(
  report: ContextReport,
  categories: GraphCategory[],
  freeTokens: number,
  unknownTokens: number,
  configuredReserve: number,
  compactionTokens: number,
  tokensPerCell: number,
  theme: Theme,
): string[] {
  const contextWindow = knownTokenValue(report.usage.contextWindow) ?? 0;
  const currentTotal = knownTokenValue(report.usage.tokens);
  const modelLabel = report.model.name || report.model.id || "unknown model";
  const modelParts = [`${report.model.provider}/${report.model.id}`];
  if (report.model.thinking) modelParts.push(`thinking ${report.model.thinking}`);

  const lines = [
    `${theme.fg("text", theme.bold(modelLabel))}${contextWindow > 0 ? theme.fg("muted", ` (${formatTokens(contextWindow)} context)`) : ""}`,
    theme.fg("muted", modelParts.join(" · ")),
    `${theme.fg("accent", formatTokens(currentTotal))}${contextWindow > 0 ? `/${formatTokens(contextWindow)}` : ""} tokens (${formatPercent(report.usage.percent)})`,
    theme.fg("muted", `1 block ≈ ${formatTokens(tokensPerCell)} tokens`),
    "",
    heading(theme, "Estimated breakdown", currentTotal),
  ];

  for (const category of categories) {
    lines.push(`${theme.fg(category.color, category.glyph)} ${category.label}: ${formatBreakdownValue(category.tokens, contextWindow, theme)}`);
  }
  if (freeTokens > 0) {
    lines.push(`${theme.fg(GRAPH_STYLE.free.color, GRAPH_STYLE.free.glyph)} Free space: ${formatBreakdownValue(freeTokens, contextWindow, theme)}`);
  }
  if (unknownTokens > 0) {
    lines.push(`${theme.fg(GRAPH_STYLE.unknown.color, GRAPH_STYLE.unknown.glyph)} Unknown capacity: ${formatBreakdownValue(unknownTokens, contextWindow, theme)}`);
  }
  if (configuredReserve > 0) {
    const remaining = compactionTokens < configuredReserve
      ? theme.fg("muted", ` · ${formatTokens(compactionTokens)} unoccupied`)
      : "";
    lines.push(`${theme.fg(GRAPH_STYLE.compaction.color, GRAPH_STYLE.compaction.glyph)} Compaction reserve: ${formatBreakdownValue(configuredReserve, contextWindow, theme)}${remaining}`);
  }

  return lines;
}

function buildGraphCategories(report: ContextReport, currentTotal: number | null): GraphCategory[] {
  const activeTools = report.tools.filter((tool) => tool.active);
  const toolTokens = sum(activeTools.map((tool) => tool.tokens));
  const toolPromptTokens = sum(activeTools.map((tool) => tool.promptTokens));
  const skillTokens = sum(report.skills.map((skill) => skill.descTokens));
  const memoryTokens = report.kind === "conversation" ? sum(report.memory.map((file) => file.tokens)) : 0;
  const conversationTokens = report.kind === "conversation" ? report.conversation.tokens : 0;
  const systemPromptTokens = Math.max(
    0,
    report.promptTokens - toolPromptTokens - skillTokens - memoryTokens,
  );
  const categories = [
    { label: "System prompt", tokens: systemPromptTokens, ...GRAPH_STYLE.prompt },
    { label: "Tools", tokens: toolTokens, ...GRAPH_STYLE.tools },
    { label: "Memory files", tokens: memoryTokens, ...GRAPH_STYLE.memory },
    { label: "Skills", tokens: skillTokens, ...GRAPH_STYLE.skills },
    { label: "Conversation", tokens: conversationTokens, ...GRAPH_STYLE.conversation },
  ].filter((category) => category.tokens > 0);
  const total = sum(categories.map((category) => category.tokens));

  if (total === 0 || currentTotal === null) return categories;
  if (total > currentTotal) return scaleCategories(categories, currentTotal);
  if (total < currentTotal) {
    return [...categories, { label: "Other", tokens: currentTotal - total, ...GRAPH_STYLE.other }];
  }
  return categories;
}

function scaleCategories(categories: GraphCategory[], targetTokens: number): GraphCategory[] {
  const total = sum(categories.map((category) => category.tokens));
  if (total <= 0 || targetTokens <= 0) return [];

  const ratio = targetTokens / total;
  const scaled = categories.map((category) => ({
    ...category,
    tokens: Math.max(0, Math.round(category.tokens * ratio)),
  }));
  let delta = targetTokens - sum(scaled.map((category) => category.tokens));
  const candidates = [...scaled].sort((a, b) => b.tokens - a.tokens);

  if (delta > 0 && candidates[0]) {
    candidates[0].tokens += delta;
    delta = 0;
  }
  for (const category of candidates) {
    if (delta >= 0) break;
    const removed = Math.min(category.tokens, -delta);
    category.tokens -= removed;
    delta += removed;
  }

  return scaled.filter((category) => category.tokens > 0);
}

function formatGraphGrid(
  categories: GraphCategory[],
  cellCount: number,
  columns: number,
  theme: Theme,
): string[] {
  const cells = allocateGraphCells(categories, cellCount);
  const lines: string[] = [];

  for (let start = 0; start < cells.length; start += columns) {
    lines.push(cells
      .slice(start, start + columns)
      .map((category) => theme.fg(category.color, category.glyph))
      .join(GRAPH_CELL_GAP));
  }

  return lines;
}

function allocateGraphCells(categories: GraphCategory[], cellCount: number): GraphCategory[] {
  const visibleCategories = categories.filter((category) => category.tokens > 0);
  if (visibleCategories.length === 0) return [];

  const targetCellCount = Math.max(cellCount, visibleCategories.length);
  const totalTokens = sum(visibleCategories.map((category) => category.tokens));
  const allocations = visibleCategories.map((category) => {
    const ideal = (category.tokens / totalTokens) * targetCellCount;
    return { category, ideal, count: Math.max(1, Math.floor(ideal)) };
  });
  let allocated = sum(allocations.map((allocation) => allocation.count));

  while (allocated > targetCellCount) {
    const donor = allocations
      .filter((allocation) => allocation.count > 1)
      .sort((a, b) => (b.count - b.ideal) - (a.count - a.ideal))[0];
    if (!donor) break;
    donor.count -= 1;
    allocated -= 1;
  }

  while (allocated < targetCellCount) {
    const recipient = [...allocations]
      .sort((a, b) => (b.ideal - b.count) - (a.ideal - a.count))[0]!;
    recipient.count += 1;
    allocated += 1;
  }

  return allocations.flatMap(({ category, count }) =>
    Array.from({ length: count }, () => category),
  );
}

function graphColumnCount(width: number, summaryWidth: number): number {
  const target = width >= 112 ? 36 : width >= 88 ? 32 : width >= 68 ? 24 : 20;
  const sideBySideWidth = width - GRAPH_GAP - summaryWidth;
  const maxWidth = sideBySideWidth >= 10 ? sideBySideWidth : width;
  return Math.max(1, Math.min(target, maxGraphColumnsForWidth(maxWidth)));
}

function maxGraphColumnsForWidth(width: number): number {
  const gapWidth = visibleWidth(GRAPH_CELL_GAP);
  return Math.max(1, Math.floor((Math.max(1, width) + gapWidth) / (1 + gapWidth)));
}

function shouldRenderSideBySide(width: number, columns: number, summaryWidth: number): boolean {
  const graphWidth = columns + (columns - 1) * visibleWidth(GRAPH_CELL_GAP);
  return width - graphWidth - GRAPH_GAP >= summaryWidth;
}

function padAnsi(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function knownTokenValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function formatConversationSection(report: Extract<ContextReport, { kind: "conversation" }>, theme: Theme): string[] {
  const stats = report.conversation.stats;
  return [
    heading(theme, "Conversation (estimated)", report.conversation.tokens),
    `${branch(theme, "├")}messages: user ${stats.userMessages} · assistant ${stats.assistantMessages} · tool results ${stats.toolResults}`,
    `${branch(theme, "├")}blocks: tool calls ${sum([...report.conversation.toolCallCounts.values()])} · thinking ${stats.thinkingBlocks} · images ${stats.imageBlocks}`,
    `${branch(theme, "├")}compactions: ${stats.compactions}`,
    `${branch(theme, "└")}message tokens: ${theme.fg("accent", formatTokens(report.conversation.tokens))}`,
  ];
}

function formatToolsSection(report: ContextReport, theme: Theme): string[] {
  if (report.tools.length === 0) return [];

  const callCounts = report.kind === "conversation"
    ? report.conversation.toolCallCounts
    : new Map<string, number>();
  const groups: Array<{ title: string; kind: ToolSource["kind"] }> = [
    { title: "Built-in tools", kind: "builtin" },
    { title: "MCP tools", kind: "mcp" },
    { title: "Extension tools", kind: "extension" },
  ];
  const activeTokens = sum(report.tools.filter((tool) => tool.active).map((tool) => tool.tokens));
  const lines = [heading(theme, "Tools (estimated)", activeTokens)];

  for (const group of groups) {
    const tools = report.tools.filter((tool) => tool.source.kind === group.kind);
    if (tools.length === 0) continue;

    const groupTokens = sum(tools.filter((tool) => tool.active).map((tool) => tool.tokens));
    lines.push(`${theme.fg("muted", "  ")}${theme.fg("text", theme.bold(group.title))}${theme.fg("muted", ` · ${formatTokens(groupTokens)} tokens`)}`);
    tools.forEach((tool, index) => {
      const tree = index === tools.length - 1 ? "└" : "├";
      const meta = `${tool.active ? "active" : "inactive"} · ${formatToolSource(tool.source)} · ${formatCallCount(callCounts.get(tool.name) ?? 0)}`;
      lines.push(`${theme.fg("muted", `    ${tree}─ `)}${theme.fg("text", tool.name)}: ${theme.fg("accent", formatTokens(tool.tokens))} tokens${theme.fg("muted", ` · ${meta}`)}`);
    });
  }

  return lines;
}

function formatDetailSection(
  title: string,
  items: DetailItem[],
  theme: Theme,
): string[] {
  if (items.length === 0) return [];

  const lines = [heading(theme, title, sum(items.map((item) => item.tokens)))];
  items.forEach((item, index) => {
    const meta = item.meta ? theme.fg("muted", ` · ${item.meta}`) : "";
    lines.push(`${branch(theme, index === items.length - 1 ? "└" : "├")}${theme.fg("text", item.label)}: ${theme.fg("accent", formatTokens(item.tokens))} tokens${meta}`);
  });

  return lines;
}

function formatToolSource(source: ToolSource): string {
  if (source.kind === "builtin") return "builtin";
  return `${source.kind}:${source.name}`;
}

function formatCallCount(count: number): string {
  return count === 1 ? "1 call" : `${count.toLocaleString()} calls`;
}

function pushSection(lines: string[], section: string[]): void {
  if (section.length === 0) return;
  if (lines.length > 0) lines.push("");
  lines.push(...section);
}

function heading(theme: Theme, text: string, tokens?: number | null): string {
  const total = tokens === undefined ? "" : theme.fg("muted", ` · ${formatTokens(tokens)} tokens`);
  return theme.fg("customMessageLabel", theme.bold(text)) + total;
}

function branch(theme: Theme, branch: TreeBranch): string {
  return theme.fg("muted", `  ${branch}─ `);
}

function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unknown";

  const tokens = Math.max(0, Math.round(value));
  const trim = (input: number) => input.toFixed(input >= 10 ? 0 : 1).replace(/\.0$/, "");
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trim(tokens / 1_000)}K`;
  return tokens.toLocaleString();
}

function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "unknown" : `${value.toFixed(1)}%`;
}

function formatBreakdownValue(tokens: number, contextWindow: number, theme: Theme): string {
  const tokenValue = `${theme.fg("accent", formatTokens(tokens))}${theme.fg("text", " tokens")}`;
  const percent = contextWindow > 0
    ? theme.fg("muted", ` · ${((tokens / contextWindow) * 100).toFixed(1)}%`)
    : "";
  return `${tokenValue}${percent}`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
