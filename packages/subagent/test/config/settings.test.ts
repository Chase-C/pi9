import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubagentSettingsStore } from "../../src/config/settings.js";

test("subagent UI settings default to below editor when file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-default-"));
  const store = new SubagentSettingsStore(join(root, "subagent", "settings.json"));

  const result = await store.load();

  assert.equal(result.settings.widgetPlacement, "belowEditor");
  assert.equal(result.settings.runtime.maxTasksPerRun, 8);
  assert.equal(result.settings.runtime.maxConcurrentSubagents, 4);
  assert.equal(result.settings.runtime.defaultResumable, false);
  assert.equal(result.settings.runtime.backgroundNotify, "auto");
  assert.deepEqual(result.settings.agentDiscovery.agentFileExtensions, [".md"]);
  assert.equal(result.settings.display.outputSnippetLength, 400);
  assert.equal(result.settings.display.toolInputSummaryLength, 80);
  assert.equal(result.settings.display.widgetShowForeground, true);
  assert.equal(result.settings.display.widgetMaxRowsPerSection, 6);
  assert.equal(result.settings.widgetLayout, "auto");
  assert.equal(result.warning, undefined);
});

test("subagent UI settings save and reload widget placement globally", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-save-"));
  const settingsPath = join(root, "subagent", "settings.json");

  await new SubagentSettingsStore(settingsPath).save({ widgetPlacement: "aboveEditor" });
  const result = await new SubagentSettingsStore(settingsPath).load();

  assert.equal(result.settings.widgetPlacement, "aboveEditor");
  assert.equal(result.settings.runtime.maxTasksPerRun, 8);
  assert.equal(result.warning, undefined);
});

test("subagent settings reject invalid values with a field-named warning and fall back to defaults", async () => {
  const cases: Array<{ label: string; written: object; expectedField: string; expectedFallback: () => Promise<void> }> = [
    {
      label: "widgetPlacement",
      written: { widgetPlacement: "besideEditor" },
      expectedField: "widgetPlacement",
      expectedFallback: async () => {},
    },
    {
      label: "backgroundNotify",
      written: { runtime: { backgroundNotify: "loud" } },
      expectedField: "backgroundNotify",
      expectedFallback: async () => {},
    },
  ];

  for (const { label, written, expectedField } of cases) {
    const root = await mkdtemp(join(tmpdir(), `subagent-settings-invalid-${label}-`));
    const settingsPath = join(root, "subagent", "settings.json");
    await mkdir(join(root, "subagent"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(written));

    const result = await new SubagentSettingsStore(settingsPath).load();

    // Defaults applied: widgetPlacement always falls back to belowEditor; runtime always has the canonical defaults.
    assert.equal(result.settings.widgetPlacement, "belowEditor", `${label}: widgetPlacement should fall back`);
    assert.equal(result.settings.runtime.backgroundNotify, "auto", `${label}: backgroundNotify should fall back`);
    assert.equal(result.settings.runtime.maxConcurrentSubagents, 4, `${label}: maxConcurrentSubagents should default`);
    assert.match(result.warning!, new RegExp(expectedField));
  }
});

test("subagent settings reject the legacy backgroundNotify names end-of-turn and next-tool-call and fall back to auto", async () => {
  for (const legacy of ["end-of-turn", "next-tool-call"] as const) {
    const root = await mkdtemp(join(tmpdir(), `subagent-settings-legacy-${legacy}-`));
    const settingsPath = join(root, "subagent", "settings.json");
    await mkdir(join(root, "subagent"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ runtime: { backgroundNotify: legacy } }));

    const result = await new SubagentSettingsStore(settingsPath).load();

    assert.equal(result.settings.runtime.backgroundNotify, "auto", `${legacy}: should fall back to auto`);
    assert.match(result.warning ?? "", /backgroundNotify/, `${legacy}: warning should mention backgroundNotify`);
  }
});

test("subagent settings load widgetLayout override and reject invalid values", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-widget-layout-"));
  const settingsPath = join(root, "subagent", "settings.json");
  await mkdir(join(root, "subagent"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ widgetLayout: "columns" }));

  const valid = await new SubagentSettingsStore(settingsPath).load();
  assert.equal(valid.settings.widgetLayout, "columns");
  assert.equal(valid.warning, undefined);

  await writeFile(settingsPath, JSON.stringify({ widgetLayout: "side-by-side" }));
  const invalid = await new SubagentSettingsStore(settingsPath).load();
  assert.equal(invalid.settings.widgetLayout, "auto");
  assert.match(invalid.warning!, /widgetLayout/);
});

test("subagent settings load widgetShowForeground and widgetMaxRowsPerSection overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-widget-"));
  const settingsPath = join(root, "subagent", "settings.json");
  await mkdir(join(root, "subagent"), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      display: { widgetShowForeground: false, widgetMaxRowsPerSection: 4 },
    }),
  );

  const result = await new SubagentSettingsStore(settingsPath).load();

  assert.equal(result.settings.display.widgetShowForeground, false);
  assert.equal(result.settings.display.widgetMaxRowsPerSection, 4);
  assert.equal(result.warning, undefined);
});

test("subagent settings reject invalid widgetShowForeground and widgetMaxRowsPerSection with warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-widget-invalid-"));
  const settingsPath = join(root, "subagent", "settings.json");
  await mkdir(join(root, "subagent"), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      display: { widgetShowForeground: "yes", widgetMaxRowsPerSection: 0 },
    }),
  );

  const result = await new SubagentSettingsStore(settingsPath).load();

  assert.equal(result.settings.display.widgetShowForeground, true);
  assert.equal(result.settings.display.widgetMaxRowsPerSection, 6);
  assert.match(result.warning!, /widgetShowForeground/);
  assert.match(result.warning!, /widgetMaxRowsPerSection/);
});

test("subagent settings load runtime, discovery, and display overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-overrides-"));
  const settingsPath = join(root, "subagent", "settings.json");
  await mkdir(join(root, "subagent"), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      widgetPlacement: "off",
      runtime: { maxTasksPerRun: 3, maxConcurrentSubagents: 2, defaultResumable: true, backgroundNotify: "steer" },
      agentDiscovery: { includeProjectAgents: false, agentFileExtensions: [".md", ".agent.md"] },
      display: { outputSnippetLength: 42, toolInputSummaryLength: 50, widgetShowRetainedSessions: false },
    }),
  );

  const result = await new SubagentSettingsStore(settingsPath).load();

  assert.equal(result.settings.widgetPlacement, "off");
  assert.deepEqual(result.settings.runtime, { maxTasksPerRun: 3, maxConcurrentSubagents: 2, defaultResumable: true, backgroundNotify: "steer" });
  assert.equal(result.settings.agentDiscovery.includeProjectAgents, false);
  assert.deepEqual(result.settings.agentDiscovery.agentFileExtensions, [".md", ".agent.md"]);
  assert.equal(result.settings.display.outputSnippetLength, 42);
  assert.equal(result.settings.display.toolInputSummaryLength, 50);
  assert.equal(result.settings.display.widgetShowRetainedSessions, false);
});
