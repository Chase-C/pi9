import { test } from "vitest";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { applySubagentSettingsChange, SubagentSettingsComponent } from "../../src/command/settings.js";
import { createDefaultSubagentSettings } from "../../src/settings.js";

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

test("settings render as a categorized split navigator", () => {
  const changes: unknown[] = [];
  const component = new SubagentSettingsComponent(
    createDefaultSubagentSettings(),
    {} as any,
    undefined,
    change => changes.push(change),
    () => {},
  );
  const output = component.render(100).map(line => line.trimEnd()).join("\n");

  assert.match(output, /Interface/);
  assert.match(output, /Notifications/);
  assert.match(output, /Runtime/);
  assert.match(output, /Widget placement · Interface/);
  assert.match(output, /Widget mode/);
  assert.match(output, /Progress rows/);
  assert.match(output, /current belowEditor/);
  assert.doesNotMatch(output, /Subagent Settings/);
  assert.ok(component.render(40).every(line => visibleWidth(line) <= 40));

  component.handleInput("\x1b[B");
  component.handleInput("\r");
  assert.deepEqual(changes, [{ kind: "widgetMode", value: "progress" }]);
});
