import { test } from "vitest";
import assert from "node:assert/strict";

import { applySubagentSettingsChange } from "../../src/command/components/settings.js";
import { createDefaultSubagentSettings } from "../../src/config/settings.js";

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
