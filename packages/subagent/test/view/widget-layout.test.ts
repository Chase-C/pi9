import { test } from "vitest";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_SUBAGENT_SETTINGS, normalizeSettings } from "../../src/config/settings.js";
import {
  maxLineWidth,
  resolveWidgetLayout,
  WIDGET_COLUMN_GUTTER,
  zipWidgetColumns,
} from "../../src/view/widget-layout.js";
import { buildWidgetModel, renderWidgetModelLines, formatThemedWidgetRow } from "../../src/view/session-lines.js";
import { fakeAgent } from "../helpers/fake-agent.js";
import { mockTheme } from "../helpers/render-widget.js";
import { SubagentWidgetComponent } from "../../src/view/widget-component.js";

test("normalizeSettings defaults widgetLayout to auto and validates enum values", () => {
  assert.equal(DEFAULT_SUBAGENT_SETTINGS.widgetLayout, "auto");
  assert.deepEqual(normalizeSettings({ widgetLayout: "columns" }).settings.widgetLayout, "columns");
  assert.deepEqual(normalizeSettings({ widgetLayout: "stacked" }).settings.widgetLayout, "stacked");
  const invalid = normalizeSettings({ widgetLayout: "grid" });
  assert.equal(invalid.settings.widgetLayout, "auto");
  assert.match(invalid.warning!, /widgetLayout/);
});

test("resolveWidgetLayout selects columns or stacked from setting and width", () => {
  const gutter = visibleWidth(WIDGET_COLUMN_GUTTER);
  assert.equal(resolveWidgetLayout("columns", 40), "columns");
  assert.equal(resolveWidgetLayout("stacked", 120), "stacked");
  assert.equal(resolveWidgetLayout("auto", 20 + gutter, false, 20), "stacked");
  assert.equal(resolveWidgetLayout("auto", 20 + gutter + 1, true, 20), "columns");
});

test("zipWidgetColumns aligns gutter after the widest natural left line", () => {
  const width = 24;
  const lines = zipWidgetColumns(["left", "more-left"], ["right-side", "r"], width, " │ ");
  assert.equal(lines[0], "left      │ right-side");
  assert.equal(lines[1], "more-left │ r");
  assert.equal(lines[0].indexOf("│"), lines[1].indexOf("│"));
  for (const line of lines) assert.ok(visibleWidth(line) <= width);

  const tight = zipWidgetColumns(["more-left"], ["right-side-extra-long"], 20, " │ ");
  assert.equal(visibleWidth(tight[0]), 20);
  assert.match(tight[0], /^more-left │ right/);
});

test("zipWidgetColumns keeps a single aligned gutter close to the left content", () => {
  const lines = zipWidgetColumns(
    ["Background · 1 running", "  ⠋ scout · 1s"],
    ["Resumable · 1 ready", "  ✓ helper · 4s"],
    80,
    " │ ",
  );
  assert.match(lines[0], /^Background · 1 running\s+│ Resumable · 1 ready$/);
  assert.match(lines[1], /^  ⠋ scout · 1s\s+│   ✓ helper · 4s$/);
  assert.equal(lines[0].indexOf("│"), lines[1].indexOf("│"));
  assert.ok(visibleWidth(lines[0]) < 80);
});

test("renderWidgetModelLines renders side-by-side columns with full-width footer at wide width", () => {
  const now = 10_000;
  const agents = [
    fakeAgent({
      id: "bg",
      dispatch: "background",
      config: { name: "scout" },
      createdAt: 1,
      status: { kind: "running", startedAt: 9_000 },
    }),
    fakeAgent({
      id: "res",
      config: { name: "helper", resumable: true },
      createdAt: 2,
      status: { kind: "completed", startedAt: 1, completedAt: 5_000, response: "ok" },
    }),
    fakeAgent({
      id: "fg",
      retention: "transient",
      config: { name: "inline" },
      createdAt: 3,
      status: { kind: "running", startedAt: 9_500 },
    }),
  ];
  const model = buildWidgetModel(agents, now);
  const formatRow = (row: Parameters<typeof formatThemedWidgetRow>[0]) => formatThemedWidgetRow(row, mockTheme());
  const width = 80;

  const stacked = renderWidgetModelLines(model, now, formatRow, { layout: "stacked", width });
  assert.equal(stacked.length, 5);
  assert.equal(stacked[0], "Background · 1 running");
  assert.equal(stacked[2], "Resumable · 1 ready");

  const columns = renderWidgetModelLines(model, now, formatRow, { layout: "columns", width });
  assert.equal(columns.length, 3);
  assert.match(columns[0], /Background · 1 running\s+│ Resumable · 1 ready/);
  assert.match(columns[1], /scout · 1s/);
  assert.match(columns[1], /helper · 4s/);
  assert.match(columns[2], /^\+1 foreground running\s*$/);
  assert.equal(visibleWidth(columns[2]), width);
});

test("renderWidgetModelLines auto layout uses stacked for background-only at wide width", () => {
  const now = 10_000;
  const agents = [
    fakeAgent({
      dispatch: "background",
      config: { name: "scout" },
      status: { kind: "running", startedAt: 9_000 },
    }),
  ];
  const model = buildWidgetModel(agents, now);
  const formatRow = (row: Parameters<typeof formatThemedWidgetRow>[0]) => formatThemedWidgetRow(row, mockTheme());

  const lines = renderWidgetModelLines(model, now, formatRow, { layout: "auto", width: 80 });
  assert.equal(lines[0], "Background · 1 running");
  assert.doesNotMatch(lines[0], /│/);
});

test("renderWidgetModelLines forced columns layout still uses columns with one section", () => {
  const now = 10_000;
  const agents = [
    fakeAgent({
      dispatch: "background",
      config: { name: "scout" },
      status: { kind: "running", startedAt: 9_000 },
    }),
  ];
  const model = buildWidgetModel(agents, now);
  const formatRow = (row: Parameters<typeof formatThemedWidgetRow>[0]) => formatThemedWidgetRow(row, mockTheme());

  const lines = renderWidgetModelLines(model, now, formatRow, { layout: "columns", width: 80 });
  assert.match(lines[0], /Background · 1 running\s+│ /);
});

test("renderWidgetModelLines auto layout uses columns when content fits side by side", () => {
  const now = 10_000;
  const agents = [
    fakeAgent({
      dispatch: "background",
      config: { name: "scout" },
      status: { kind: "running", startedAt: 9_000 },
    }),
    fakeAgent({
      id: "res",
      config: { name: "helper", resumable: true },
      status: { kind: "completed", startedAt: 1, completedAt: 5_000, response: "ok" },
    }),
  ];
  const model = buildWidgetModel(agents, now);
  const formatRow = (row: Parameters<typeof formatThemedWidgetRow>[0]) => formatThemedWidgetRow(row, mockTheme());

  const narrow = renderWidgetModelLines(model, now, formatRow, { layout: "auto", width: 60 });
  assert.match(narrow[0], /Background · 1 running\s+│ Resumable · 1 ready/);
  assert.match(narrow[1], /scout · 1s/);
  assert.match(narrow[1], /helper · 4s/);
});

test("renderWidgetModelLines auto layout falls back to stacked when gutter cannot fit", () => {
  const now = 10_000;
  const agents = [
    fakeAgent({
      dispatch: "background",
      config: { name: "scout" },
      status: { kind: "running", startedAt: 9_000 },
    }),
    fakeAgent({
      id: "res",
      config: { name: "helper", resumable: true },
      status: { kind: "completed", startedAt: 1, completedAt: 5_000, response: "ok" },
    }),
  ];
  const model = buildWidgetModel(agents, now);
  const formatRow = (row: Parameters<typeof formatThemedWidgetRow>[0]) => formatThemedWidgetRow(row, mockTheme());
  const leftWidth = maxLineWidth(["Background · 1 running", "  ⠋ scout · 1s"]);
  const tooNarrow = leftWidth + visibleWidth(WIDGET_COLUMN_GUTTER);

  const stacked = renderWidgetModelLines(model, now, formatRow, { layout: "auto", width: tooNarrow });
  assert.equal(stacked[0], "Background · 1 running");
  assert.equal(stacked[2], "Resumable · 1 ready");
});

test("renderWidgetModelLines truncates wide glyphs per column without breaking alignment", () => {
  const now = 10_000;
  const agents = [
    fakeAgent({
      id: "bg-parent",
      dispatch: "background",
      label: "Orchestrator",
      config: { name: "orchestrator" },
      createdAt: 1,
      status: { kind: "running", startedAt: 9_000 },
    }),
    fakeAgent({
      id: "bg-child",
      parentSessionId: "bg-parent",
      dispatch: "background",
      config: { name: "worker" },
      createdAt: 2,
      status: { kind: "running", startedAt: 9_000 },
    }),
    fakeAgent({
      id: "res",
      config: { name: "helper-with-a-long-resumable-name-too", resumable: true },
      createdAt: 3,
      status: { kind: "completed", startedAt: 1, completedAt: 5_000, response: "ok" },
    }),
  ];
  const model = buildWidgetModel(agents, now);
  const formatRow = (row: Parameters<typeof formatThemedWidgetRow>[0]) => formatThemedWidgetRow(row, mockTheme());
  const width = 80;
  const lines = renderWidgetModelLines(model, now, formatRow, { layout: "columns", width });

  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(visibleWidth(line) <= width);
  assert.match(lines[2], /↳ Orch/);
});

test("SubagentWidgetComponent threads widgetLayout into column rendering", () => {
  const now = 10_000;
  const agents = [
    fakeAgent({
      dispatch: "background",
      config: { name: "scout" },
      status: { kind: "running", startedAt: 9_000 },
    }),
    fakeAgent({
      id: "res",
      config: { name: "helper", resumable: true },
      status: { kind: "completed", startedAt: 1, completedAt: 5_000, response: "ok" },
    }),
  ];
  const model = buildWidgetModel(agents, now);
  const stacked = new SubagentWidgetComponent(model, mockTheme(), "stacked").render(80);
  assert.equal(stacked[0], "Background · 1 running");

  const columns = new SubagentWidgetComponent(model, mockTheme(), "columns").render(80);
  assert.match(columns[0], /Background · 1 running\s+│ Resumable · 1 ready/);
});
