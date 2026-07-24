import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { applySubagentSettingsChange, SubagentSettingsComponent } from "../../src/command/settings.js";
import { createDefaultSubagentSettings } from "../../src/settings.js";

function settingsComponent(settings = createDefaultSubagentSettings(), theme: any = {}) {
  const changes: unknown[] = [];
  const done = vi.fn();
  const requestRender = vi.fn();
  const component = new SubagentSettingsComponent(
    settings,
    theme,
    undefined,
    change => changes.push(change),
    done,
    requestRender,
  );
  component.focused = true;
  return { component, changes, done, requestRender };
}

function down(component: SubagentSettingsComponent, count: number) {
  for (let index = 0; index < count; index++) component.handleInput("\x1b[B");
}

function output(component: SubagentSettingsComponent, width = 100) {
  return component.render(width).map(line => line.trimEnd()).join("\n");
}

test("settings changes immutably apply nested fields", () => {
  const original = createDefaultSubagentSettings();
  const applied = applySubagentSettingsChange(original, {
    kind: "maxConcurrentSubagents",
    value: 12,
  });

  assert.equal(applied.runtime.maxConcurrentSubagents, 12);
  assert.notEqual(applied, original);
  assert.notEqual(applied.runtime, original.runtime);
  assert.equal(applied.display, original.display);
  assert.equal(original.runtime.maxConcurrentSubagents, 4);
});

test("settings changes compose", () => {
  const original = createDefaultSubagentSettings();
  const conversations = applySubagentSettingsChange(original, {
    kind: "maxConversations",
    value: 200,
  });
  const notify = applySubagentSettingsChange(conversations, {
    kind: "completionNotify",
    value: "steer",
  });

  assert.equal(notify.runtime.maxConversations, 200);
  assert.equal(notify.runtime.completionNotify, "steer");
});

test("settings render as a padded, color-distinguished inspector", () => {
  const fg = vi.fn((_color: string, text: string) => text);
  const { component, changes } = settingsComponent(createDefaultSubagentSettings(), { fg });
  const rendered = output(component);

  assert.match(rendered, /  INTERFACE/);
  assert.match(rendered, /  NOTIFICATIONS/);
  assert.match(rendered, /  RUNTIME/);
  assert.match(rendered, /Widget placement\s+‹ belowEditor ›/);
  assert.match(rendered, /Widget mode\s+‹ summary ›/);
  assert.match(rendered, /Max running\s+\[ 4 \]/);
  const labels = ["Widget placement", "Widget mode", "Progress rows", "Completion notify", "Max running"];
  const listLines = component.render(100).map(line => line.split("│")[0]).filter(line => labels.some(label => line.includes(label)));
  const valueColumns = listLines.map(line => {
    const columns = [line.indexOf("‹"), line.indexOf("[")].filter(column => column >= 0);
    return Math.min(...columns);
  });
  assert.equal(new Set(valueColumns).size, 1);
  assert.ok(valueColumns[0] <= 24);
  assert.match(rendered, /Widget placement · Interface/);
  assert.match(rendered, /LIVE PREVIEW/);
  assert.match(rendered, /Subagents  2 running · 1 queued · 12 retained/);
  assert.ok(component.render(40).every(line => visibleWidth(line) <= 40));
  assert.ok(fg.mock.calls.some(([color, text]) => color === "accent" && text === "INTERFACE"));
  assert.ok(fg.mock.calls.some(([color, text]) => color === "accent" && text === "┃"));
  assert.ok(fg.mock.calls.some(([color, text]) => color === "accent" && text === "‹ belowEditor ›"));
  assert.ok(fg.mock.calls.some(([color, text]) => color === "muted" && text === "Widget mode"));
  assert.ok(fg.mock.calls.some(([color, text]) => color === "text" && text === "Widget placement"));

  component.handleInput("\x1b[B");
  component.handleInput("\r");
  assert.deepEqual(changes, [{ kind: "widgetMode", value: "progress" }]);
});

test("progress rows is unavailable in summary mode and enables immediately in progress mode", () => {
  const { component, changes } = settingsComponent();

  down(component, 2);
  assert.match(output(component), /Progress rows\s+\[ 6 \]/);
  assert.doesNotMatch(output(component), /progress mode only/);
  assert.match(output(component), /Unavailable while Widget mode is summary/);
  component.handleInput("\r");
  component.handleInput(" ");
  assert.equal(component.isEditing, false);
  assert.deepEqual(changes, []);

  component.handleInput("\x1b[A");
  component.handleInput(" ");
  component.handleInput("\x1b[B");
  assert.doesNotMatch(output(component), /Unavailable while Widget mode is summary/);
  component.handleInput(" ");
  assert.equal(component.isEditing, true);
});

test("numeric settings accept arbitrary positive integers", () => {
  const settings = createDefaultSubagentSettings();
  settings.widgetMode = "progress";
  const { component, changes } = settingsComponent(settings);

  down(component, 2);
  component.handleInput("\r");
  component.handleInput("\x15");
  component.handleInput("13");
  component.handleInput("\r");

  assert.equal(component.isEditing, false);
  assert.deepEqual(changes, [{ kind: "widgetMaxRowsPerSection", value: 13 }]);
  assert.match(output(component), /current 13/);
  assert.match(output(component), /task-13/);
  assert.match(output(component), /⋮ 9 rows/);
});

test("numeric editing validates and can be cancelled without saving", () => {
  const settings = createDefaultSubagentSettings();
  settings.widgetMode = "progress";
  const { component, changes } = settingsComponent(settings);

  down(component, 2);
  component.handleInput("\r");
  component.handleInput("\x15");
  component.handleInput("0");
  component.handleInput("\r");
  assert.equal(component.isEditing, true);
  assert.match(output(component), /Enter a positive whole number\./);
  assert.deepEqual(changes, []);

  component.handleInput("\x1b");
  assert.equal(component.isEditing, false);
  assert.match(output(component), /current 6/);
  assert.deepEqual(changes, []);
});

test("progress previews represent both small and large row limits", () => {
  const small = createDefaultSubagentSettings();
  small.widgetMode = "progress";
  small.display.widgetMaxRowsPerSection = 3;
  const smallComponent = settingsComponent(small).component;
  down(smallComponent, 2);
  assert.match(output(smallComponent), /task-3 · queued/);
  assert.doesNotMatch(output(smallComponent), /⋮/);

  const large = createDefaultSubagentSettings();
  large.widgetMode = "progress";
  large.display.widgetMaxRowsPerSection = 8;
  const largeComponent = settingsComponent(large).component;
  down(largeComponent, 2);
  const largeOutput = output(largeComponent);
  assert.match(largeOutput, /⋮ 4 rows/);
  assert.match(largeOutput, /task-8 · queued/);
  assert.match(largeOutput, /\+2 more/);
});

test("completion notification preview uses behavior diagrams rather than fake UI", () => {
  const { component } = settingsComponent();
  down(component, 3);

  const auto = output(component);
  assert.match(auto, /BEHAVIOR/);
  assert.match(auto, /wait for parent to become idle/);
  assert.match(auto, /notify and trigger response/);
  assert.doesNotMatch(auto, /Parent conversation/);

  component.handleInput("\r");
  const steer = output(component);
  assert.match(steer, /next eligible active-turn opportunity/);
  assert.match(steer, /steer notification/);
  assert.match(steer, /If the parent is idle/);

  component.handleInput("\r");
  assert.match(output(component), /no automatic notification/);
});
