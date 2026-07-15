import { test } from "vitest";
import assert from "node:assert/strict";

import { applySubagentSettingsChange } from "../../src/command/components/settings.js";
import { createDefaultSubagentSettings } from "../../src/config/settings.js";

test("settings change reducer immutably applies nested fields and returns confirmation metadata", () => {
  const original = createDefaultSubagentSettings();
  const applied = applySubagentSettingsChange(original, {
    kind: "maxConcurrentSubagents",
    value: 12,
  });

  assert.equal(applied.settings.runtime.maxConcurrentSubagents, 12);
  assert.equal(applied.confirmation, "Subagent max running set to 12.");
  assert.notEqual(applied.settings, original);
  assert.notEqual(applied.settings.runtime, original.runtime);
  assert.equal(applied.settings.display, original.display);
  assert.equal(original.runtime.maxConcurrentSubagents, 4);
});
