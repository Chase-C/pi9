import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  CONTEXT_REPORT_HELP,
  contentViewportLines,
  createContextReportComponent,
  formatContextReportLines,
} from "../src/component.js";
import type { ContextReport } from "../src/types.js";

const report: ContextReport = {
  kind: "conversation",
  model: {
    provider: "test-provider",
    id: "test-model",
    name: "Test Model",
    thinking: "medium",
    contextWindow: 1_000,
  },
  usage: { contextWindow: 1_000, tokens: 640, percent: 64 },
  compaction: { enabled: false, reserveTokens: 0 },
  promptTokens: 100,
  tools: [
    { name: "bash", tokens: 80, definitionTokens: 70, promptTokens: 10, source: { kind: "builtin" }, active: true },
    { name: "custom_tool", tokens: 40, definitionTokens: 35, promptTokens: 5, source: { kind: "extension", name: "test" }, active: true },
    { name: "inactive_tool", tokens: 20, definitionTokens: 20, promptTokens: 0, source: { kind: "extension", name: "test" }, active: false },
  ],
  skills: [
    { name: "skill:test", descTokens: 30, bodyTokens: 120, scope: "project" },
  ],
  memory: [
    { path: "AGENTS.md", tokens: 50 },
  ],
  snapshot: { capturedAt: Date.now() },
  conversation: {
    tokens: 340,
    stats: {
      userMessages: 2,
      assistantMessages: 2,
      toolResults: 1,
      toolCalls: 1,
      thinkingBlocks: 0,
      imageBlocks: 0,
      compactions: 2,
    },
    history: [
      { kind: "tool-call", tool: "bash", tokens: 10 },
    ],
  },
};

const graphReport: ContextReport = {
  kind: "static",
  model: {
    provider: "test-provider",
    id: "static-model",
    name: "Static Model",
    contextWindow: 5_000,
  },
  usage: { contextWindow: 5_000, tokens: 3_000, percent: 60 },
  compaction: { enabled: false, reserveTokens: 0 },
  promptTokens: 2_000,
  tools: [
    { name: "bash", tokens: 1_000, definitionTokens: 1_000, promptTokens: 0, source: { kind: "builtin" }, active: true },
  ],
  skills: [],
};

const largeGraphReport: ContextReport = {
  kind: "static",
  model: {
    provider: "test-provider",
    id: "large-model",
    name: "Large Model",
    contextWindow: 50_000,
  },
  usage: { contextWindow: 50_000, tokens: 20_000, percent: 40 },
  compaction: { enabled: false, reserveTokens: 0 },
  promptTokens: 20_000,
  tools: [],
  skills: [],
};

const plainTheme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

const ansiTheme = {
  fg: (_role: string, text: string) => `\u001b[36m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
};

const roleTheme = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bold: (text: string) => text,
};

describe("context report formatting", () => {
  it("formats section headers with token totals", () => {
    const text = formatContextReportLines(report, plainTheme as never).join("\n");

    expect(text).not.toContain("Context Usage");
    expect(text).toContain("Estimated breakdown · 640 tokens");
    expect(text).toContain("● System prompt: 5 tokens · 0.5%");
    expect(text).toContain("● Tools: 120 tokens · 12.0%");
    expect(text).toContain("● Other: 95 tokens · 9.5%");
    expect(text).toContain("◉ Conversation: 340 tokens · 34.0%");
    expect(text).toContain("○ Free space: 360 tokens · 36.0%");
    expect(text).toContain("Conversation (estimated) · 340 tokens");
    expect(text).toContain("compactions: 2");
    expect(text).toContain("Memory files (estimated) · 50 tokens");
    expect(text).toContain("Tools (estimated) · 120 tokens");
    expect(text).not.toContain("definition 70");
    expect(text).not.toContain("prompt 10");
    expect(text).not.toContain("Snapshot:");
    expect(text).toContain("Skills (estimated) · 30 tokens");
  });

  it("highlights breakdown tokens and mutes percentages", () => {
    const text = formatContextReportLines(report, roleTheme as never).join("\n");

    expect(text).toContain("System prompt: <accent>5</accent><text> tokens</text><muted> · 0.5%</muted>");
  });

  it("groups tools by source without hiding overflow", () => {
    const tools: ContextReport["tools"] = [
      ...Array.from({ length: 13 }, (_, index) => ({
        name: `builtin_${index}`,
        tokens: 10,
        definitionTokens: 10,
        promptTokens: 0,
        source: { kind: "builtin" } as const,
        active: true,
      })),
      { name: "mcp_search", tokens: 20, definitionTokens: 20, promptTokens: 0, source: { kind: "mcp", name: "test-mcp" }, active: true },
      { name: "custom_tool", tokens: 30, definitionTokens: 30, promptTokens: 0, source: { kind: "extension", name: "test-extension" }, active: true },
    ];
    const text = formatContextReportLines({ ...graphReport, tools }, plainTheme as never).join("\n");

    expect(text).toContain("Built-in tools");
    expect(text).toContain("MCP tools");
    expect(text).toContain("Extension tools");
    expect(text).toContain("builtin_12");
    expect(text).not.toMatch(/… \d+ more/);
  });

  it("adjusts graph density to the available width", () => {
    const narrowLines = formatContextReportLines(graphReport, plainTheme as never, 20);
    const wideLines = formatContextReportLines(graphReport, plainTheme as never, 40);
    const graphPattern = /^[●○ ]+$/;
    const narrowGraph = narrowLines.filter((line) => graphPattern.test(line));
    const wideGraph = wideLines.filter((line) => graphPattern.test(line));

    expect(narrowGraph).toHaveLength(7);
    expect(wideGraph).toHaveLength(7);
    const narrowCells = narrowGraph.join("").replaceAll(" ", "");
    expect(narrowCells).toHaveLength(70);
    expect(wideGraph.join("").replaceAll(" ", "")).toHaveLength(140);
    const coloredGraph = formatContextReportLines(graphReport, roleTheme as never, 20)
      .filter((line) => /^(?:<[^>]+>[●○◉]<\/[^>]+>(?: |$))+$/.test(line))
      .join("");
    expect(coloredGraph.match(/<text>●<\/text>/g)).toHaveLength(28);
    expect(coloredGraph.match(/<warning>●<\/warning>/g)).toHaveLength(14);
    expect(coloredGraph.match(/<borderMuted>○<\/borderMuted>/g)).toHaveLength(28);
    expect(narrowLines.join("\n")).toContain("1 block ≈ 71 tokens");
    expect(wideLines.join("\n")).toContain("1 block ≈ 36 tokens");
  });

  it("matches graph rows to the side-by-side summary", () => {
    const lines = formatContextReportLines(report, plainTheme as never, 80);
    const overviewEnd = lines.indexOf("", 1);
    const overviewLines = lines.slice(1, overviewEnd);

    expect(overviewLines).toHaveLength(13);
    expect(overviewLines.every((line) => /^[●○◉]/.test(line))).toBe(true);
  });

  it("shows every non-zero category in the graph with its assigned color", () => {
    const lines = formatContextReportLines(report, roleTheme as never, 20);
    const graph = lines
      .filter((line) => /^(?:<[^>]+>[●○◉]<\/[^>]+>(?: |$))+$/.test(line))
      .join("");

    for (const marker of [
      "<text>●</text>",
      "<warning>●</warning>",
      "<error>●</error>",
      "<success>●</success>",
      "<accent>◉</accent>",
      "<muted>●</muted>",
      "<borderMuted>○</borderMuted>",
    ]) {
      expect(graph).toContain(marker);
    }
  });

  it("shows enabled compaction reserve in the graph and breakdown", () => {
    const compactionReport: ContextReport = {
      ...graphReport,
      compaction: { enabled: true, reserveTokens: 1_000 },
    };
    const lines = formatContextReportLines(compactionReport, roleTheme as never, 20);
    const text = lines.join("\n");
    const graph = lines
      .filter((line) => /^(?:<[^>]+>[●○◉]<\/[^>]+>(?: |$))+$/.test(line))
      .join("");

    expect(graph.match(/<warning>●<\/warning>/g)).toHaveLength(28);
    expect(text).toContain("<warning>●</warning> Compaction reserve: <accent>1K</accent><text> tokens</text><muted> · 20.0%</muted>");
  });

  it("shows how much reserve remains when usage crosses the compaction threshold", () => {
    const compactionReport: ContextReport = {
      ...graphReport,
      usage: { contextWindow: 5_000, tokens: 4_200, percent: 84 },
      compaction: { enabled: true, reserveTokens: 1_000 },
    };
    const text = formatContextReportLines(compactionReport, plainTheme as never, 80).join("\n");

    expect(text).toContain("● Compaction reserve: 1K tokens · 20.0% · 800 unoccupied");
  });

  it("counts spaces when wrapping graph cells", () => {
    const lines = formatContextReportLines(largeGraphReport, plainTheme as never, 20);
    const graphLines = lines.filter((line) => /^[●○ ]+$/.test(line));

    expect(graphLines.length).toBeGreaterThan(1);
    expect(graphLines[0]).toContain(" ");
    for (const line of graphLines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it("renders unknown capacity separately when current usage is unavailable", () => {
    const unknownUsageReport: ContextReport = {
      ...graphReport,
      usage: { contextWindow: 5_000, tokens: null, percent: null },
    };

    const lines = formatContextReportLines(unknownUsageReport, roleTheme as never, 20);
    const text = lines.join("\n");
    const graph = lines
      .filter((line) => /^(?:<[^>]+>[●○◉]<\/[^>]+>(?: |$))+$/.test(line))
      .join("");

    expect(graph).toContain("<dim>●</dim>");
    expect(text).toContain("●</dim> Unknown capacity: <accent>2K</accent>");
  });
});

describe("context report component", () => {
  it("keeps rendered lines within the requested width", () => {
    const component = createContextReportComponent(report, {
      theme: ansiTheme as never,
      tui: { terminal: { rows: 18 }, requestRender: vi.fn() } as never,
      onClose: vi.fn(),
    });
    const lines = component.render(48);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(48);
    }
  });

  it("preserves full compaction details at 80 columns", () => {
    const compactionReport: ContextReport = {
      ...graphReport,
      usage: { contextWindow: 5_000, tokens: 4_200, percent: 84 },
      compaction: { enabled: true, reserveTokens: 1_000 },
    };
    const component = createContextReportComponent(compactionReport, {
      theme: plainTheme as never,
      tui: { terminal: { rows: 40 }, requestRender: vi.fn() } as never,
      onClose: vi.fn(),
    });
    const text = component.render(80).join("\n");

    expect(text).toContain("● Compaction reserve: 1K tokens · 20.0% · 800 unoccupied");
  });

  it("renders keyboard controls in the top border", () => {
    const component = createContextReportComponent(report, {
      theme: plainTheme as never,
      tui: { terminal: { rows: 18 }, requestRender: vi.fn() } as never,
      onClose: vi.fn(),
    });
    const lines = component.render(100);

    expect(lines[0]).toContain(" Context Report ──── ↑↓/jk scroll");
    const paddingRow = `│${" ".repeat(98)}│`;
    expect(lines[1]).toBe(paddingRow);
    expect(lines.slice(1).join("\n")).not.toContain(CONTEXT_REPORT_HELP);

    component.handleInput?.("j");
    expect(component.render(100)[1]).not.toBe(paddingRow);

    const styledComponent = createContextReportComponent(report, {
      theme: ansiTheme as never,
      tui: { terminal: { rows: 18 }, requestRender: vi.fn() } as never,
      onClose: vi.fn(),
    });
    expect(styledComponent.render(100)[0]).toContain("\u001b[1m Context Report \u001b[22m");
  });

  it("pages with d and u", () => {
    const requestRender = vi.fn();
    const component = createContextReportComponent(report, {
      theme: plainTheme as never,
      tui: { terminal: { rows: 10 }, requestRender } as never,
      onClose: vi.fn(),
    });
    component.render(48);

    component.handleInput?.("d");
    component.handleInput?.("u");

    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["escape", "\u001b"],
    ["q", "q"],
  ])("closes on %s", (_name, input) => {
    const onClose = vi.fn();
    const component = createContextReportComponent(report, {
      theme: plainTheme as never,
      tui: { terminal: { rows: 18 }, requestRender: vi.fn() } as never,
      onClose,
    });

    component.handleInput?.(input);

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("contentViewportLines", () => {
  it("reserves space for the view chrome", () => {
    expect(contentViewportLines(40)).toBe(33);
    expect(contentViewportLines(10)).toBe(6);
    expect(contentViewportLines(6)).toBe(2);
  });
});
