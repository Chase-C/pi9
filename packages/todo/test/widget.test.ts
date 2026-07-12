import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";

import type { TodoState } from "../src/types.js";
import { TodoWidgetComponent } from "../src/widget-component.js";
import { updateTodoWidget } from "../src/widget.js";
import { renderTodoWidgetLines } from "../src/widget-layout.js";

afterEach(() => vi.useRealTimers());

const state: TodoState = {
  phases: [
    { name: "Plan", tasks: [
      { name: "Active task", status: "in_progress" },
      { name: "First pending task", status: "pending" },
      { name: "Finished task", status: "completed" },
      { name: "Cancelled task", status: "cancelled" },
    ] },
    { name: "Build", tasks: [{ name: "Second pending task", status: "pending" }] },
  ],
};

test("todo widget nests numbered phases and shows tasks only under the active phase", () => {
  const lines = renderTodoWidgetLines(state, { bold: (text: string) => `<bold>${text}</bold>` } as never, 80, { maxVisible: 2, fallbackGlyphs: true });
  assert.match(lines[0], /Todos.*1 active.*2 pending.*1 completed.*1 cancelled/);
  assert.match(lines[1], /<bold>  1\. Plan.*1 active.*1 pending/);
  assert.match(lines[2], /<bold>    ▶ Active task<\/bold>/);
  assert.match(lines[3], /    ○ First pending task/);
  assert.match(lines[4], /1 complete task · 1 cancelled task/);
  assert.match(lines[5], /  2\. Build/);
  assert.doesNotMatch(lines.join("\n"), /\[1\]|\[2\]|Second pending task/);
});

test("todo widget summarizes terminal tasks beneath the selected phase", () => {
  const themed = renderTodoWidgetLines(state, {
    bold: (text: string) => `<bold>${text}</bold>`,
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  } as never, 80, { maxVisible: 10, fallbackGlyphs: true }).join("\n");
  assert.match(themed, /<toolTitle><bold>Todos/);
  assert.match(themed, /<toolTitle><bold>  1\. Plan/);
  assert.match(themed, /<dim>    \+ 1 complete task · 1 cancelled task<\/dim>/);
  assert.doesNotMatch(themed, /Finished task|Cancelled task|\[3\]|\[4\]/);
});

test("todo widget prioritizes statuses stably and shows every active task over the limit", () => {
  const activeState: TodoState = {
    phases: [{ name: "Work", tasks: [
      { name: "pending first", status: "pending" },
      { name: "active first", status: "in_progress" },
      { name: "completed", status: "completed" },
      { name: "active second", status: "in_progress" },
      { name: "pending second", status: "pending" },
    ] }],
  };
  const lines = renderTodoWidgetLines(activeState, undefined, 80, { maxVisible: 1, fallbackGlyphs: true });
  const text = lines.join("\n");
  assert.ok(text.indexOf("active first") < text.indexOf("active second"));
  assert.doesNotMatch(lines.slice(2).join("\n"), /pending first|completed|pending second/);
  assert.match(text, /\+2 more/);
  assert.match(text, /1 complete task/);
});

test("todo widget falls back to the first pending phase and disappears when all tasks are terminal", () => {
  const pendingState: TodoState = {
    phases: [
      { name: "Done", tasks: [{ name: "old", status: "completed" }] },
      { name: "Next", tasks: [{ name: "ready", status: "pending" }] },
      { name: "Later", tasks: [{ name: "later", status: "pending" }] },
    ],
  };
  const pendingLines = renderTodoWidgetLines(pendingState, undefined, 80, { fallbackGlyphs: true });
  assert.match(pendingLines.join("\n"), /  2\. Next[\s\S]*    ○ ready/);
  assert.doesNotMatch(pendingLines.join("\n"), /    ○ later/);

  const terminalLines = renderTodoWidgetLines({
    phases: [{ name: "Done", tasks: [
      { name: "finished", status: "completed" },
      { name: "cancelled", status: "cancelled" },
    ] }],
  }, undefined, 80, { fallbackGlyphs: true });
  assert.deepEqual(terminalLines, []);
});

test("todo widget remains safe at narrow widths", () => {
  const lines = renderTodoWidgetLines(state, undefined, 4, { maxVisible: 10 });
  for (const line of lines) assert.ok(visibleWidth(line) <= 4);

  const component = new TodoWidgetComponent(state, undefined, { maxVisible: 1 });
  for (const line of component.render(1)) assert.ok(visibleWidth(line) <= 1);
});

test("todo widget animates Nerd Font active markers with the droplet timing and stops when disposed", () => {
  vi.useFakeTimers();
  const requestRender = vi.fn();
  const component = new TodoWidgetComponent(state, undefined, {}, { requestRender } as never);

  assert.match(component.render(80).join("\n"), / Active task/);
  vi.advanceTimersByTime(219);
  assert.equal(requestRender.mock.calls.length, 0);
  vi.advanceTimersByTime(1);
  assert.match(component.render(80).join("\n"), / Active task/);
  assert.equal(requestRender.mock.calls.length, 1);

  component.dispose();
  vi.advanceTimersByTime(1_000);
  assert.equal(requestRender.mock.calls.length, 1);
});

test("todo widget uses pi's activity spinner when Nerd Font glyphs are disabled", () => {
  vi.useFakeTimers();
  const requestRender = vi.fn();
  const component = new TodoWidgetComponent(state, undefined, { fallbackGlyphs: true }, { requestRender } as never);

  assert.match(component.render(80).join("\n"), /⠋ Active task/);
  vi.advanceTimersByTime(80);
  assert.match(component.render(80).join("\n"), /⠙ Active task/);
  assert.equal(requestRender.mock.calls.length, 1);
  component.dispose();
});

test("updateTodoWidget supplies a component factory, honors placement, and clears terminal state", () => {
  const calls: unknown[][] = [];
  updateTodoWidget({ hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } }, state, {
    widgetPlacement: "aboveEditor",
    maxVisibleTasks: 1,
  });
  assert.equal(calls[0][0], "todo");
  assert.equal(typeof calls[0][1], "function");
  assert.deepEqual(calls[0][2], { placement: "aboveEditor" });

  updateTodoWidget({ hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } }, {
    phases: [{ name: "Done", tasks: [{ name: "finished", status: "completed" }] }],
  }, {});
  assert.deepEqual(calls[1], ["todo", undefined, { placement: "aboveEditor" }]);

  updateTodoWidget({ hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } }, { phases: [] }, {});
  assert.deepEqual(calls[2], ["todo", undefined, { placement: "aboveEditor" }]);

  updateTodoWidget({ hasUI: false, ui: { setWidget: (...args: unknown[]) => calls.push(args) } }, state, {});
  assert.equal(calls.length, 3);
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
