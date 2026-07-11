import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";

import type { TodoState } from "../src/types.js";
import { TodoWidgetComponent } from "../src/widget-component.js";
import { updateTodoWidget } from "../src/widget.js";
import { renderTodoWidgetLines } from "../src/widget-layout.js";

const state: TodoState = {
  nextId: 5,
  phases: [
    { name: "Plan", tasks: [
      { id: "1", content: "Active task", status: "in_progress" },
      { id: "2", content: "First pending task", status: "pending" },
      { id: "3", content: "Finished task", status: "completed" },
    ] },
    { name: "Build", tasks: [{ id: "4", content: "Second pending task", status: "pending" }] },
  ],
};

test("todo widget has phase summaries, emphasizes active work, and bounds its preview", () => {
  const lines = renderTodoWidgetLines(state, { bold: (text: string) => `<bold>${text}</bold>` } as never, 80, { maxVisible: 2, fallbackGlyphs: true });
  assert.match(lines[0], /Todo.*1 active.*2 pending.*1 completed/);
  assert.match(lines[1], /Plan.*1 active.*1 pending.*1 completed/);
  assert.match(lines.join("\n"), /<bold>  ▶ \[1\] Active task<\/bold>/);
  assert.match(lines.join("\n"), /○ \[2\] First pending task/);
  assert.match(lines.join("\n"), /\+1 more/);
  assert.doesNotMatch(lines.join("\n"), /Finished task/);
});

test("todo widget can include and style completed tasks and remains safe at narrow widths", () => {
  const themed = renderTodoWidgetLines(state, {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    strikethrough: (text: string) => `<strike>${text}</strike>`,
  } as never, 80, { showCompleted: true, maxVisible: 10, fallbackGlyphs: true }).join("\n");
  assert.match(themed, /<success>  ✓ \[3\] <strike>Finished task<\/strike><\/success>/);
  assert.match(renderTodoWidgetLines(state, undefined, 80, { maxVisible: 1 }).join("\n"), /󰻃 \[1\] Active task/);
  const lines = renderTodoWidgetLines(state, undefined, 4, { showCompleted: true, maxVisible: 10 });
  for (const line of lines) assert.ok(visibleWidth(line) <= 4);

  const component = new TodoWidgetComponent(state, undefined, { maxVisible: 1 });
  for (const line of component.render(1)) assert.ok(visibleWidth(line) <= 1);
});

test("updateTodoWidget supplies a component factory and honors placement, empty state, and UI guard", () => {
  const calls: unknown[][] = [];
  updateTodoWidget({ hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } }, state, {
    widgetPlacement: "aboveEditor",
    maxVisibleTasks: 1,
  });
  assert.equal(calls[0][0], "todo");
  assert.equal(typeof calls[0][1], "function");
  assert.deepEqual(calls[0][2], { placement: "aboveEditor" });

  updateTodoWidget({ hasUI: true, ui: { setWidget: (...args: unknown[]) => calls.push(args) } }, { nextId: 1, phases: [] }, {});
  assert.deepEqual(calls[1], ["todo", undefined, { placement: "aboveEditor" }]);

  updateTodoWidget({ hasUI: false, ui: { setWidget: (...args: unknown[]) => calls.push(args) } }, state, {});
  assert.equal(calls.length, 2);
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
