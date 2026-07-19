import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultSubagentSettings, normalizeSettings, SubagentSettingsStore } from "../../src/config/settings.js";

test("subagent default settings are fresh and include redesigned runtime defaults", () => {
  const first = createDefaultSubagentSettings();
  first.runtime.maxTasksPerRun = 99;
  first.agentDiscovery.agentFileExtensions.push(".agent.md");
  const second = createDefaultSubagentSettings();
  assert.equal(second.runtime.maxTasksPerRun, 8);
  assert.equal(second.runtime.maxConversations, 100);
  assert.equal(second.runtime.completionNotify, "auto");
  assert.deepEqual(second.agentDiscovery.agentFileExtensions, [".md"]);
  assert.notEqual(first.runtime, second.runtime);
});

test("missing settings use defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-default-"));
  const result = await new SubagentSettingsStore(join(root, "subagent", "settings.json")).load();
  assert.equal(result.settings.widgetPlacement, "belowEditor");
  assert.equal(result.settings.runtime.maxConversations, 100);
  assert.equal(result.settings.runtime.completionNotify, "auto");
  assert.equal(result.warning, undefined);
});

test("settings load redesigned runtime overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-overrides-"));
  const path = join(root, "subagent", "settings.json");
  await mkdir(join(root, "subagent"), { recursive: true });
  await writeFile(path, JSON.stringify({ runtime: { maxConversations: 25, completionNotify: "steer" } }));
  const result = await new SubagentSettingsStore(path).load();
  assert.equal(result.settings.runtime.maxConversations, 25);
  assert.equal(result.settings.runtime.completionNotify, "steer");
  assert.equal(result.warning, undefined);
});

test("invalid redesigned runtime values warn and use defaults", () => {
  const result = normalizeSettings({ runtime: { maxConversations: 0, completionNotify: "loud" } });
  assert.equal(result.settings.runtime.maxConversations, 100);
  assert.equal(result.settings.runtime.completionNotify, "auto");
  assert.match(result.warning!, /maxConversations/);
  assert.match(result.warning!, /completionNotify/);
});

test("save and reload preserves complete settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-settings-save-"));
  const path = join(root, "subagent", "settings.json");
  const settings = createDefaultSubagentSettings();
  settings.widgetPlacement = "aboveEditor";
  await new SubagentSettingsStore(path).save(settings);
  const result = await new SubagentSettingsStore(path).load();
  assert.equal(result.settings.widgetPlacement, "aboveEditor");
  assert.equal(result.settings.runtime.maxConversations, 100);
});
