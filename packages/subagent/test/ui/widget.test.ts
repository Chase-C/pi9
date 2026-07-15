import { test, vi } from "vitest";
import assert from "node:assert/strict";

import { updateSubagentWidget } from "../../src/ui/widget.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";
import { fakeAgent } from "../helpers/fake-agent.js";
import { mockTheme, renderWidgetContent, type WidgetComponentFactory } from "../helpers/render-widget.js";

test("updateSubagentWidget passes a component factory to setWidget when content exists", () => {
  const widgets: unknown[][] = [];
  const agents = [
    fakeAgent({
      dispatch: "background",
      config: { name: "scout" },
      status: { kind: "running", startedAt: 9_000 },
    }),
  ];

  updateSubagentWidget(
    {
      hasUI: true,
      ui: {
        setWidget: (...args: unknown[]) => widgets.push(args),
      },
    },
    agents,
    DEFAULT_SUBAGENT_SETTINGS,
  );

  assert.equal(widgets.length, 1);
  assert.equal(widgets[0][0], "subagent");
  assert.equal(typeof widgets[0][1], "function");
  assert.deepEqual(widgets[0][2], { placement: DEFAULT_SUBAGENT_SETTINGS.widgetPlacement });
});

test("updateSubagentWidget factory renders stacked content with theme-colored status glyphs", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  try {
    const widgets: unknown[][] = [];
    const agents = [
      fakeAgent({
        id: "bg-run",
        dispatch: "background",
        config: { name: "scout" },
        createdAt: 1,
        status: { kind: "running", startedAt: 9_000 },
      }),
      fakeAgent({
        id: "bg-done",
        dispatch: "background",
        retention: "persistent",
        config: { name: "reviewer" },
        createdAt: 2,
        status: { kind: "completed", startedAt: 1, completedAt: 5_000, response: "ok" },
      }),
    ];

    updateSubagentWidget(
      {
        hasUI: true,
        ui: { setWidget: (...args: unknown[]) => widgets.push(args) },
      },
      agents,
      DEFAULT_SUBAGENT_SETTINGS,
    );

    const lines = renderWidgetContent(widgets[0][1], mockTheme(), 60);
    assert.equal(lines[0], "Background · 1 running · 1 ready");
    assert.match(lines[1], /\[accent\][⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\[\/\] scout · 1s/);
    assert.match(lines[2], /\[success\]✓\[\/\] reviewer · 4s/);
  } finally {
    vi.useRealTimers();
  }
});

test("updateSubagentWidget component re-render refreshes elapsed time and running glyph", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  try {
    const widgets: unknown[][] = [];
    updateSubagentWidget(
      {
        hasUI: true,
        ui: { setWidget: (...args: unknown[]) => widgets.push(args) },
      },
      [
        fakeAgent({
          dispatch: "background",
          config: { name: "scout" },
          status: { kind: "running", startedAt: 9_000 },
        }),
      ],
      DEFAULT_SUBAGENT_SETTINGS,
    );

    const factory = widgets[0][1] as WidgetComponentFactory;
    const component = factory({}, mockTheme());
    assert.match(component.render(80)[1], /scout · 1s/);

    vi.setSystemTime(12_000);
    assert.match(component.render(80)[1], /scout · 3s/);
  } finally {
    vi.useRealTimers();
  }
});

test("updateSubagentWidget clears the widget when placement is off", () => {
  const widgets: unknown[][] = [];
  updateSubagentWidget(
    {
      hasUI: true,
      ui: { setWidget: (...args: unknown[]) => widgets.push(args) },
    },
    [fakeAgent({ dispatch: "background", status: { kind: "running", startedAt: 1 } })],
    { ...DEFAULT_SUBAGENT_SETTINGS, widgetPlacement: "off" },
  );

  assert.deepEqual(widgets, [["subagent", undefined]]);
});

test("updateSubagentWidget no-ops without UI", () => {
  const widgets: unknown[][] = [];
  updateSubagentWidget(
    { hasUI: false, ui: { setWidget: (...args: unknown[]) => widgets.push(args) } },
    [fakeAgent({ dispatch: "background", status: { kind: "running", startedAt: 1 } })],
    DEFAULT_SUBAGENT_SETTINGS,
  );

  assert.deepEqual(widgets, []);
});

test("updateSubagentWidget clears the widget when only foreground-transient agents are active", () => {
  const widgets: unknown[][] = [];
  updateSubagentWidget(
    {
      hasUI: true,
      ui: { setWidget: (...args: unknown[]) => widgets.push(args) },
    },
    [
      fakeAgent({ retention: "transient", config: { name: "inline" }, status: { kind: "running", startedAt: 1 } }),
    ],
    DEFAULT_SUBAGENT_SETTINGS,
  );

  assert.deepEqual(widgets, [["subagent", undefined, { placement: DEFAULT_SUBAGENT_SETTINGS.widgetPlacement }]]);
});

test("updateSubagentWidget keeps active foreground-resumable agents visible", () => {
  const widgets: unknown[][] = [];
  updateSubagentWidget(
    {
      hasUI: true,
      ui: { setWidget: (...args: unknown[]) => widgets.push(args) },
    },
    [
      fakeAgent({
        retention: "persistent",
        config: { name: "resumable-inline", resumable: true },
        status: { kind: "running", startedAt: 1 },
      }),
    ],
    DEFAULT_SUBAGENT_SETTINGS,
  );

  assert.equal(typeof widgets[0][1], "function");
  const lines = renderWidgetContent(widgets[0][1] as WidgetComponentFactory, mockTheme(), 80).join("\n");
  assert.match(lines, /Resumable · 1 running/);
  assert.match(lines, /resumable-inline/);
});

test("updateSubagentWidget notifies on render failure", () => {
  const notifications: unknown[][] = [];
  updateSubagentWidget(
    {
      hasUI: true,
      ui: {
        setWidget() {
          throw new Error("widget host unavailable");
        },
        notify: (...args: unknown[]) => notifications.push(args),
      },
    },
    [fakeAgent({ dispatch: "background", status: { kind: "running", startedAt: 1 } })],
    DEFAULT_SUBAGENT_SETTINGS,
  );

  assert.equal(notifications.length, 1);
  assert.match(String(notifications[0][0]), /Subagent UI update failed: widget host unavailable/);
  assert.equal(notifications[0][1], "warning");
});
