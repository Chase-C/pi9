import { test } from "vitest";
import assert from "node:assert/strict";
import { loadSubagentSettings } from "../../src/config/load-settings.js";

test("loadSubagentSettings normalizes partial injected results with defaults", async () => {
  const loaded = await loadSubagentSettings(
    { hasUI: false },
    { load: async () => ({ settings: { widgetPlacement: "aboveEditor", runtime: { maxConcurrentSubagents: 7 } } }) } as any,
  );

  assert.equal(loaded.widgetPlacement, "aboveEditor");
  assert.equal(loaded.runtime.maxConcurrentSubagents, 7);
  assert.equal(loaded.runtime.maxTasksPerRun, 8);
  assert.equal(loaded.display.widgetMaxRowsPerSection, 6);
  assert.deepEqual(loaded.agentDiscovery.agentFileExtensions, [".md"]);
});

test("loadSubagentSettings preserves injected warning text", async () => {
  const warning = "Invalid subagent completionNotify; using default.";
  const notifications: Array<{ message: string; level?: string }> = [];
  await loadSubagentSettings(
    { hasUI: true, ui: { notify: (message, level) => notifications.push({ message, level }) } },
    { load: async () => ({ settings: { widgetPlacement: "belowEditor" }, warning }) } as any,
  );

  assert.deepEqual(notifications, [{ message: warning, level: "warning" }]);
});
