import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubagentUiSettingsStore } from "../../src/ui/settings.js";

test("subagent UI settings default to below editor when file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-default-"));
  const store = new SubagentUiSettingsStore(join(root, "subagent", "settings.json"));

  const result = await store.load();

  assert.equal(result.settings.widgetPlacement, "belowEditor");
  assert.equal(result.settings.runtime.maxTasksPerRun, 8);
  assert.equal(result.settings.runtime.maxConcurrentSubagents, 4);
  assert.equal(result.settings.runtime.defaultResumable, false);
  assert.equal(result.settings.runtime.backgroundNotify, "end-of-turn");
  assert.deepEqual(result.settings.agentDiscovery.agentFileExtensions, [".md"]);
  assert.equal(result.settings.display.outputSnippetLength, 400);
  assert.equal(result.warning, undefined);
});

test("subagent UI settings save and reload widget placement globally", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-save-"));
  const settingsPath = join(root, "subagent", "settings.json");

  await new SubagentUiSettingsStore(settingsPath).save({ widgetPlacement: "aboveEditor" });
  const result = await new SubagentUiSettingsStore(settingsPath).load();

  assert.equal(result.settings.widgetPlacement, "aboveEditor");
  assert.equal(result.settings.runtime.maxTasksPerRun, 8);
  assert.equal(result.warning, undefined);
});

test("subagent settings reject invalid backgroundNotify value with a warning and fall back to default", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-bad-notify-"));
  const settingsPath = join(root, "subagent", "settings.json");
  await mkdir(join(root, "subagent"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ runtime: { backgroundNotify: "loud" } }));

  const result = await new SubagentUiSettingsStore(settingsPath).load();

  assert.equal(result.settings.runtime.backgroundNotify, "end-of-turn");
  assert.match(result.warning!, /backgroundNotify/);
});

test("subagent UI settings fall back to defaults for invalid config", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-invalid-"));
  const settingsPath = join(root, "subagent", "settings.json");
  await mkdir(join(root, "subagent"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ widgetPlacement: "besideEditor" }));

  const result = await new SubagentUiSettingsStore(settingsPath).load();

  assert.equal(result.settings.widgetPlacement, "belowEditor");
  assert.equal(result.settings.runtime.maxConcurrentSubagents, 4);
  assert.match(result.warning!, /widgetPlacement/);
});

test("subagent settings load runtime, discovery, and display overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-overrides-"));
  const settingsPath = join(root, "subagent", "settings.json");
  await mkdir(join(root, "subagent"), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      widgetPlacement: "off",
      runtime: { maxTasksPerRun: 3, maxConcurrentSubagents: 2, defaultResumable: true, backgroundNotify: "next-tool-call" },
      agentDiscovery: { includeProjectAgents: false, agentFileExtensions: [".md", ".agent.md"] },
      display: { outputSnippetLength: 42, widgetShowRetainedSessions: false },
    }),
  );

  const result = await new SubagentUiSettingsStore(settingsPath).load();

  assert.equal(result.settings.widgetPlacement, "off");
  assert.deepEqual(result.settings.runtime, { maxTasksPerRun: 3, maxConcurrentSubagents: 2, defaultResumable: true, backgroundNotify: "next-tool-call" });
  assert.equal(result.settings.agentDiscovery.includeProjectAgents, false);
  assert.deepEqual(result.settings.agentDiscovery.agentFileExtensions, [".md", ".agent.md"]);
  assert.equal(result.settings.display.outputSnippetLength, 42);
  assert.equal(result.settings.display.widgetShowRetainedSessions, false);
});
