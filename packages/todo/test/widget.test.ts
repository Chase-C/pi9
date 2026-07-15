import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";

import type { TodoState } from "../src/types.js";
import { TodoWidgetComponent } from "../src/widget-component.js";
import { updateTodoWidget } from "../src/widget.js";
import { renderTodoWidgetLines } from "../src/widget-layout.js";
import { todo } from "./helpers.js";

afterEach(() => vi.useRealTimers());

const state: TodoState = {
  phases: [
    { name: "Plan", tasks: [
      todo("Active task", "in_progress"),
      todo("First pending task"),
      todo("Finished task", "completed"),
      todo("Cancelled task", "cancelled"),
    ] },
    { name: "Build", tasks: [todo("Second pending task")] },
  ],
  workingOn: "Updating the todo widget",
};

test("todo widget nests numbered phases and shows tasks only under the active phase", () => {
  const lines = renderTodoWidgetLines(state, { bold: (text: string) => `<bold>${text}</bold>` } as never, 80, { maxVisible: 2, fallbackGlyphs: true });
  assert.equal(lines[0], "<bold>Todos</bold>");
  assert.equal(lines[1], "<bold>  1. Plan</bold> · 2/4");
  assert.equal(lines[2], "    ▶ Active task");
  assert.match(lines[3], /    ○ First pending task/);
  assert.match(lines[4], /1 complete task · 1 cancelled task/);
  assert.equal(lines[5], "  2. Build · 0/1");
  assert.equal(lines[6], "");
  assert.equal(lines[7], "  󰅂 Updating the todo widget");
  assert.doesNotMatch(lines.join("\n"), /Detailed description|\[1\]|\[2\]|Second pending task/);
});

test("todo widget summarizes terminal tasks beneath the selected phase", () => {
  const themed = renderTodoWidgetLines(state, {
    bold: (text: string) => `<bold>${text}</bold>`,
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  } as never, 80, { maxVisible: 10, fallbackGlyphs: true }).join("\n");
  assert.match(themed, /<toolTitle><bold>Todos<\/bold><\/toolTitle>\n/);
  assert.match(themed, /<toolTitle><bold>  1\. Plan<\/bold><\/toolTitle> <dim>· 2\/4<\/dim>/);
  assert.match(themed, /<dim>    ▶<\/dim> <text>Active task<\/text>/);
  assert.doesNotMatch(themed, /<text>    ▶<\/text>|<bold>    ▶ Active task<\/bold>/);
  assert.match(themed, /<dim>    \+ 1 complete task · 1 cancelled task<\/dim>/);
  assert.match(themed, /  <dim>󰅂 Updating the todo widget<\/dim>/);
  assert.doesNotMatch(themed, /Finished task|Cancelled task|\[3\]|\[4\]|Working on:/);
});

test("todo widget prioritizes statuses stably and shows every active task over the limit", () => {
  const activeState: TodoState = {
    phases: [{ name: "Work", tasks: [
      todo("pending first"),
      todo("active first", "in_progress"),
      todo("completed", "completed"),
      todo("active second", "in_progress"),
      todo("pending second"),
    ] }],
    workingOn: "Handling both active tasks",
  };
  const lines = renderTodoWidgetLines(activeState, undefined, 80, { maxVisible: 1, fallbackGlyphs: true });
  const text = lines.join("\n");
  assert.ok(text.indexOf("active first") < text.indexOf("active second"));
  assert.doesNotMatch(lines.slice(2).join("\n"), /pending first|completed|pending second/);
  assert.match(text, /\+2 more/);
  assert.match(text, /1 complete task/);
});

test("todo widget falls back to the first pending phase and renders terminal phase summaries", () => {
  const pendingState: TodoState = {
    phases: [
      { name: "Done", tasks: [todo("old", "completed")] },
      { name: "Next", tasks: [todo("ready")] },
      { name: "Later", tasks: [todo("later")] },
    ],
  };
  const pendingLines = renderTodoWidgetLines(pendingState, undefined, 80, { fallbackGlyphs: true });
  assert.match(pendingLines.join("\n"), /  2\. Next[\s\S]*    ○ ready/);
  assert.doesNotMatch(pendingLines.join("\n"), /    ○ later/);

  const terminalLines = renderTodoWidgetLines({
    phases: [{ name: "Done", tasks: [
      todo("finished", "completed"),
      todo("cancelled", "cancelled"),
    ] }],
  }, undefined, 80, { fallbackGlyphs: true });
  assert.match(terminalLines.join("\n"), /  1\. Done · 2\/2[\s\S]*1 complete task · 1 cancelled task/);
});

test("todo widget remains safe at narrow widths", () => {
  const lines = renderTodoWidgetLines(state, undefined, 4, { maxVisible: 10 });
  for (const line of lines) assert.ok(visibleWidth(line) <= 4);

  const component = new TodoWidgetComponent(state, undefined, { maxVisible: 1 });
  for (const line of component.render(1)) assert.ok(visibleWidth(line) <= 1);
});

test("todo widget keeps active markers static and animates the working line with pi's spinner", () => {
  vi.useFakeTimers();
  const requestRender = vi.fn();
  const component = new TodoWidgetComponent(state, undefined, {}, { requestRender } as never);

  const initial = component.render(80).join("\n");
  assert.match(initial, /󰻃 Active task/);
  assert.match(initial, /\n\n  󰅂 Updating the todo widget/);
  vi.advanceTimersByTime(119);
  assert.equal(requestRender.mock.calls.length, 0);
  vi.advanceTimersByTime(1);
  const next = component.render(80).join("\n");
  assert.match(next, /󰻃 Active task/);
  assert.match(next, /\n\n  󰄾 Updating the todo widget/);
  assert.equal(requestRender.mock.calls.length, 1);

  component.dispose();
  vi.advanceTimersByTime(1_000);
  assert.equal(requestRender.mock.calls.length, 1);
});

test("todo widget keeps the working marker static while the agent is idle", () => {
  vi.useFakeTimers();
  const requestRender = vi.fn();
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as never;
  const component = new TodoWidgetComponent(state, theme, { animateWorkingMarker: false }, { requestRender } as never);

  assert.match(component.render(80).join("\n"), /  <dim>󰅂 Updating the todo widget<\/dim>/);
  vi.advanceTimersByTime(1_000);
  assert.equal(requestRender.mock.calls.length, 0);
  assert.match(component.render(80).join("\n"), /  <dim>󰅂 Updating the todo widget<\/dim>/);
  component.dispose();
});

test("fallback glyphs do not change the working-line spinner", () => {
  vi.useFakeTimers();
  const requestRender = vi.fn();
  const component = new TodoWidgetComponent(state, undefined, { fallbackGlyphs: true }, { requestRender } as never);

  const initial = component.render(80).join("\n");
  assert.match(initial, /▶ Active task/);
  assert.match(initial, /  󰅂 Updating the todo widget/);
  vi.advanceTimersByTime(120);
  assert.match(component.render(80).join("\n"), /  󰄾 Updating the todo widget/);
  assert.equal(requestRender.mock.calls.length, 1);
  component.dispose();
});

test("updateTodoWidget animates only while the agent is active", () => {
  vi.useFakeTimers();

  for (const [idle, expectedRenders] of [[true, 0], [false, 1]] as const) {
    const calls: unknown[][] = [];
    const requestRender = vi.fn();
    updateTodoWidget({
      hasUI: true,
      isIdle: () => idle,
      ui: { setWidget: (...args: unknown[]) => calls.push(args) },
    }, state);
    const component = (calls[0][1] as (tui: never, theme: never) => TodoWidgetComponent)({ requestRender } as never, undefined as never);

    vi.advanceTimersByTime(120);
    assert.equal(requestRender.mock.calls.length, expectedRenders);
    component.dispose();
  }
});

test("updateTodoWidget shows terminal state for five seconds before clearing", () => {
  vi.useFakeTimers();
  const calls: unknown[][] = [];
  const context = { hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } };
  updateTodoWidget(context, state, {
    widgetPlacement: "aboveEditor",
    maxVisibleTasks: 1,
  });
  assert.equal(calls[0][0], "todo");
  assert.equal(typeof calls[0][1], "function");
  assert.deepEqual(calls[0][2], { placement: "aboveEditor" });
  const component = (calls[0][1] as (tui: never, theme: never) => TodoWidgetComponent)({ requestRender() { } } as never, undefined as never);
  assert.equal(component.render(80).at(-1), "");
  component.dispose();

  updateTodoWidget(context, {
    phases: [{ name: "Done", tasks: [todo("finished", "completed")] }],
  }, {});
  assert.equal(typeof calls[1][1], "function");
  const finalComponent = (calls[1][1] as (tui: never, theme: never) => TodoWidgetComponent)(undefined as never, undefined as never);
  assert.match(finalComponent.render(80).join("\n"), /1\. Done · 1\/1[\s\S]*1 complete task/);
  vi.advanceTimersByTime(4_999);
  assert.equal(calls.length, 2);
  vi.advanceTimersByTime(1);
  assert.deepEqual(calls[2], ["todo", undefined]);

  updateTodoWidget(context, { phases: [] }, {});
  assert.deepEqual(calls[3], ["todo", undefined, { placement: "aboveEditor" }]);

  updateTodoWidget({ hasUI: false, ui: { setWidget: (...args: unknown[]) => calls.push(args) } }, state, {});
  assert.equal(calls.length, 4);
});

test("repeated terminal refreshes preserve the final summary until its timer expires", () => {
  vi.useFakeTimers();
  const calls: unknown[][] = [];
  const context = { hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } };
  const terminalState: TodoState = {
    phases: [{ name: "Done", tasks: [{ name: "finished", description: "Finished the work.", status: "completed" }] }],
  };

  updateTodoWidget(context, state);
  updateTodoWidget(context, terminalState);
  vi.advanceTimersByTime(2_500);
  updateTodoWidget(context, terminalState);

  assert.equal(typeof calls[2][1], "function");
  vi.advanceTimersByTime(2_499);
  assert.equal(calls.length, 3);
  vi.advanceTimersByTime(1);
  assert.deepEqual(calls[3], ["todo", undefined]);
});

test("an already-terminal restored plan stays hidden", () => {
  vi.useFakeTimers();
  const calls: unknown[][] = [];
  const context = { hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } };
  updateTodoWidget(context, {
    phases: [{ name: "Done", tasks: [{ name: "finished", description: "Finished the work.", status: "completed" }] }],
  });

  assert.deepEqual(calls, [["todo", undefined, { placement: "aboveEditor" }]]);
  vi.advanceTimersByTime(5_000);
  assert.equal(calls.length, 1);
});

test("new open work cancels a pending terminal clear", () => {
  vi.useFakeTimers();
  const calls: unknown[][] = [];
  const context = { hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } };
  const terminalState: TodoState = {
    phases: [{ name: "Done", tasks: [{ name: "finished", description: "Finished the work.", status: "completed" }] }],
  };
  updateTodoWidget(context, state);
  updateTodoWidget(context, terminalState);
  updateTodoWidget(context, state);

  vi.advanceTimersByTime(5_000);
  assert.equal(calls.length, 3);
  assert.equal(typeof calls[2][1], "function");
});

test("updateTodoWidget clears when off and warns if setWidget fails", () => {
  const calls: unknown[][] = [];
  updateTodoWidget({ hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } }, state, { widgetPlacement: "off" });
  assert.deepEqual(calls, [["todo", undefined]]);

  const notices: unknown[][] = [];
  updateTodoWidget({
    hasUI: true,
    ui: {
      setWidget() { throw new Error("unavailable"); },
      notify: (...args: unknown[]) => notices.push(args),
    },
  }, state, {});
  assert.match(String(notices[0][0]), /Todo widget update failed: unavailable/);
  assert.equal(notices[0][1], "warning");
});
