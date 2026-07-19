import { test } from "vitest";
import assert from "node:assert/strict";

import { DEFAULT_SUBAGENT_SETTINGS, normalizeSettings } from "../../src/config/settings.js";
import { prepareSubagentRuntime } from "../../src/runtime/prepare-subagent-runtime.js";

const baseCtx = () => ({ cwd: "/some/cwd", hasUI: false, ui: { notify: () => {} } });

function fakeManager() {
  const calls: Array<{ maxRunning?: number }> = [];
  return {
    calls,
    configure(options: { maxRunning?: number }) { calls.push(options); },
  };
}

function fakeRegistry() {
  const calls: Array<{ cwd: string; discovery?: unknown; onWarning?: (msg: string) => void }> = [];
  return {
    calls,
    async reload(cwd: string, options: { discovery?: unknown; onWarning?: (msg: string) => void } = {}) {
      calls.push({ cwd, ...options });
    },
  };
}

function fakeStore(settings: any = { widgetPlacement: "belowEditor" }, warning?: string) {
  return {
    async load() {
      const normalized = normalizeSettings(settings);
      return warning ? { settings: normalized.settings, warning } : normalized;
    },
  };
}

test("prepareSubagentRuntime returns settings loaded from the store", async () => {
  const settings = await prepareSubagentRuntime({
    ctx: baseCtx(),
    settingsStore: fakeStore({ widgetPlacement: "aboveEditor", runtime: { maxConcurrentSubagents: 7 } }),
    agentManager: fakeManager(),
  });

  assert.equal(settings.widgetPlacement, "aboveEditor");
  assert.equal(settings.runtime.maxConcurrentSubagents, 7);
});

test("prepareSubagentRuntime configures the agent manager with maxConcurrentSubagents", async () => {
  const manager = fakeManager();
  await prepareSubagentRuntime({
    ctx: baseCtx(),
    settingsStore: fakeStore({ widgetPlacement: "belowEditor", runtime: { maxConcurrentSubagents: 3 } }),
    agentManager: manager,
  });

  assert.deepEqual(manager.calls, [{ maxRunning: 3, maxConversations: DEFAULT_SUBAGENT_SETTINGS.runtime.maxConversations }]);
});

test("prepareSubagentRuntime reloads the registry with discovery and a warning callback", async () => {
  const registry = fakeRegistry();
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = { cwd: "/work/repo", hasUI: true, ui: { notify: (m: string, l?: string) => notifications.push({ message: m, level: l }) } };

  await prepareSubagentRuntime({
    ctx,
    settingsStore: fakeStore({
      widgetPlacement: "belowEditor",
      runtime: { maxConcurrentSubagents: 2, maxConversations: 17 },
      agentDiscovery: { includeUserAgents: false },
    }),
    agentManager: fakeManager(),
    agentRegistry: registry,
  });

  assert.equal(registry.calls.length, 1);
  const [call] = registry.calls;
  assert.equal(call.cwd, "/work/repo");
  assert.equal((call.discovery as any).includeUserAgents, false);

  // Warning callback should route through ctx.ui.notify with level "warning".
  call.onWarning?.("bad agent");
  assert.deepEqual(notifications, [{ message: "bad agent", level: "warning" }]);
});

test("prepareSubagentRuntime skips registry reload when none is provided", async () => {
  // Should simply not throw and still configure the manager.
  const manager = fakeManager();
  const settings = await prepareSubagentRuntime({
    ctx: baseCtx(),
    settingsStore: fakeStore({ widgetPlacement: "belowEditor", runtime: { maxConcurrentSubagents: 5 } }),
    agentManager: manager,
  });
  assert.equal(settings.runtime.maxConcurrentSubagents, 5);
  assert.deepEqual(manager.calls, [{ maxRunning: 5, maxConversations: DEFAULT_SUBAGENT_SETTINGS.runtime.maxConversations }]);
});

test("prepareSubagentRuntime surfaces settings load warnings via ctx.ui.notify", async () => {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = { cwd: "/cwd", hasUI: true, ui: { notify: (m: string, l?: string) => notifications.push({ message: m, level: l }) } };

  await prepareSubagentRuntime({
    ctx,
    settingsStore: fakeStore({ widgetPlacement: "belowEditor" }, "Invalid settings; using defaults."),
    agentManager: fakeManager(),
  });

  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.message, /Invalid settings/);
  assert.equal(notifications[0]!.level, "warning");
});

test("prepareSubagentRuntime falls back to default settings when the store throws", async () => {
  const ctx = baseCtx();
  const manager = fakeManager();
  const settings = await prepareSubagentRuntime({
    ctx,
    settingsStore: { async load() { throw new Error("disk gone"); } },
    agentManager: manager,
  });

  // Falls back to defaults and still configures the manager with the default maxConcurrentSubagents.
  assert.equal(settings.runtime.maxConcurrentSubagents, DEFAULT_SUBAGENT_SETTINGS.runtime.maxConcurrentSubagents);
  assert.deepEqual(manager.calls, [{ maxRunning: DEFAULT_SUBAGENT_SETTINGS.runtime.maxConcurrentSubagents, maxConversations: DEFAULT_SUBAGENT_SETTINGS.runtime.maxConversations }]);
});
