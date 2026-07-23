import { expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createDefaultSubagentSettings } from "../../src/settings.js";
import { formatProgressWidgetLines, updateSubagentWidget } from "../../src/widget.js";
import { fakeAgent } from "../helpers/fake-agent.js";
import { renderWidgetContent } from "../helpers/render-widget.js";

test("progress mode renders one active line and excludes settled conversations", () => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000);
  try {
    const settings = createDefaultSubagentSettings();
    settings.widgetMode = "progress";
    const setWidget = vi.fn();

    updateSubagentWidget(
      { hasUI: true, ui: { setWidget } },
      [
        fakeAgent({ label: "Investigate", config: { name: "scout" }, status: { kind: "running", startedAt: 1_000 } }),
        fakeAgent({ conversationId: "settled", status: { kind: "completed" } }),
      ],
      settings,
    );

    expect(renderWidgetContent(setWidget.mock.calls[0]![1], undefined, 120))
      .toEqual(["● Investigate · scout · running 4s · starting…"]);
  } finally {
    vi.useRealTimers();
  }
});

test("progress mode falls back to the agent name and shows queued elapsed time", () => {
  expect(formatProgressWidgetLines([
    fakeAgent({ config: { name: "planner" }, status: { kind: "queued", queuedAt: 2_000 } }),
  ], 7_000)).toEqual(["○ planner · queued 5s · starting…"]);
});

test("progress activity prefers the unfinished latest tool and its input", () => {
  expect(formatProgressWidgetLines([
    fakeAgent({
      status: { kind: "running", startedAt: 1_000 },
      messageSnippet: "Writing an answer",
      activity: { toolHistory: [
        { id: "old", name: "ls", startedAt: 1, completedAt: 2, inputSummary: "src" },
        { id: "current", name: "read", startedAt: 3, inputSummary: "src/widget.ts" },
      ] },
    }),
  ], 5_000)).toEqual(["● helper · running 4s · read src/widget.ts"]);
});

test("progress activity uses the current assistant message before completed tools", () => {
  expect(formatProgressWidgetLines([
    fakeAgent({
      status: { kind: "running", startedAt: 1_000 },
      messageSnippet: "Writing\n  an answer",
      activity: { toolHistory: [{ id: "done", name: "read", startedAt: 1, completedAt: 2, inputSummary: "src" }] },
    }),
  ], 5_000)).toEqual(["● helper · running 4s · Writing an answer"]);
});

test("progress activity falls back to the most recently completed tool", () => {
  expect(formatProgressWidgetLines([
    fakeAgent({
      status: { kind: "running", startedAt: 1_000 },
      activity: { toolHistory: [
        { id: "older", name: "ls", startedAt: 1, completedAt: 2, inputSummary: "src" },
        { id: "latest", name: "grep", startedAt: 3, completedAt: 4, inputSummary: "TODO" },
      ] },
    }),
  ], 5_000)).toEqual(["● helper · running 4s · grep TODO"]);
});

test("progress mode clears when no conversations are active", () => {
  const settings = createDefaultSubagentSettings();
  settings.widgetMode = "progress";
  const setWidget = vi.fn();

  updateSubagentWidget(
    { hasUI: true, ui: { setWidget } },
    [fakeAgent({ status: { kind: "completed" } }), fakeAgent({ conversationId: "failed", status: { kind: "error" } })],
    settings,
  );

  expect(setWidget).toHaveBeenCalledWith("subagent", undefined, { placement: "belowEditor" });
});

test("progress mode truncates long activity without wrapping", () => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000);
  try {
    const settings = createDefaultSubagentSettings();
    settings.widgetMode = "progress";
    const setWidget = vi.fn();
    updateSubagentWidget(
      { hasUI: true, ui: { setWidget } },
      [fakeAgent({ status: { kind: "running", startedAt: 1_000 }, messageSnippet: "A very long assistant response that must stay on one line" })],
      settings,
    );

    const lines = renderWidgetContent(setWidget.mock.calls[0]![1], undefined, 20);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(20);
    expect(lines[0]).toContain("…");
  } finally {
    vi.useRealTimers();
  }
});

test("progress mode limits active rows and appends an overflow line", () => {
  vi.useFakeTimers();
  vi.setSystemTime(2_000);
  try {
    const settings = createDefaultSubagentSettings();
    settings.widgetMode = "progress";
    settings.display.widgetMaxRowsPerSection = 2;
    const setWidget = vi.fn();
    updateSubagentWidget(
      { hasUI: true, ui: { setWidget } },
      [
        fakeAgent({ conversationId: "one", label: "One", status: { kind: "running", startedAt: 1_000 } }),
        fakeAgent({ conversationId: "two", label: "Two", status: { kind: "queued", queuedAt: 1_000 } }),
        fakeAgent({ conversationId: "three", label: "Three", status: { kind: "running", startedAt: 1_000 } }),
      ],
      settings,
    );

    expect(renderWidgetContent(setWidget.mock.calls[0]![1], undefined, 120)).toEqual([
      "● One · helper · running 1s · starting…",
      "○ Two · helper · queued 1s · starting…",
      "+1 more",
    ]);
  } finally {
    vi.useRealTimers();
  }
});
