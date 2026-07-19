import { test } from "vitest";
import assert from "node:assert/strict";
import { createDefaultSubagentSettings } from "../../src/config/settings.js";
import { loadSubagentSettings } from "../../src/config/load-settings.js";

test("loadSubagentSettings returns the store's normalized settings", async () => {
  const settings = createDefaultSubagentSettings();
  settings.widgetPlacement = "aboveEditor";
  settings.runtime.maxConcurrentSubagents = 7;
  const loaded = await loadSubagentSettings(
    { hasUI: false },
    { load: async () => ({ settings }) },
  );

  assert.equal(loaded, settings);
});

test("loadSubagentSettings preserves store warning text", async () => {
  const warning = "Invalid subagent completionNotify; using default.";
  const notifications: Array<{ message: string; level?: string }> = [];
  await loadSubagentSettings(
    { hasUI: true, ui: { notify: (message, level) => notifications.push({ message, level }) } },
    { load: async () => ({ settings: createDefaultSubagentSettings(), warning }) },
  );

  assert.deepEqual(notifications, [{ message: warning, level: "warning" }]);
});
