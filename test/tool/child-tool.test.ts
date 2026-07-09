import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import type { AgentManager } from "../../src/runtime/agent-manager.js";
import { makeChildSubagentTool } from "../../src/tool/child-tool.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";
import { baseCtx, makeManager, makeSession, run } from "../helpers/runtime.js";

type FakeRegistry = { agents: Map<string, any>; reload?: () => Promise<void>; summarizeAgent?: () => string };

const noop: AgentUpdateListener = () => {};
const baseAgentConfig = { name: "helper", description: "d", systemPrompt: "s", source: "project" as const, resumable: false };

function captureChildTool(
  manager: AgentManager,
  registry: any,
  parent: Agent,
  getCurrentSettings: () => any = () => DEFAULT_SUBAGENT_SETTINGS,
): any {
  return makeChildSubagentTool({ manager, registry, parent, getCurrentSettings });
}

test("makeChildSubagentTool returns a 'subagent' tool", () => {
  const registry: FakeRegistry = { agents: new Map() };
  const manager = makeManager(registry as any);
  const parent = new Agent("parent-1", baseAgentConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);

  const tool = makeChildSubagentTool({
    manager, registry: registry as any, parent,
    getCurrentSettings: () => DEFAULT_SUBAGENT_SETTINGS,
  });

  assert.equal(tool.name, "subagent");
  assert.equal(typeof tool.execute, "function");
});

test("child subagent tool delegates action=run to the shared manager with parentId set", async () => {
  const seenParents: Array<string | undefined> = [];
  const runner = async (_ctx: any, agent: any) => {
    seenParents.push(agent.parentId);
    agent.attach(makeSession());
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = makeManager(registry as any, 2, runner);
  const parent = new Agent("parent-7", baseAgentConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  const tool = captureChildTool(manager, registry, parent);

  const result = await tool.execute(
    "call-1",
    { action: "run", tasks: [{ agent: "worker", prompt: "delegate" }] },
    undefined,
    undefined,
    baseCtx(),
  );

  assert.equal(result.isError, false, `unexpected error: ${result.content?.[0]?.text}`);
  assert.deepEqual(seenParents, ["parent-7"]);
});

test("child subagent tool forwards list, results, and remove actions straight to the shared manager", async () => {
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 2, runner);
  await run(manager,baseCtx(), undefined, [{ kind: "spawn", agent: "worker", prompt: "seed" }]);
  const seeded = manager.listSessions();
  assert.equal(seeded.length, 1);
  const seededId = seeded[0].id;

  const parent = new Agent("parent-7", baseAgentConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  const tool = captureChildTool(manager, registry, parent);

  const list = await tool.execute("c-list", { action: "list" }, undefined, undefined, baseCtx());
  assert.equal(list.isError, false);
  assert.deepEqual(list.details.sessions.map((s: any) => s.id), [seededId]);

  const results = await tool.execute("c-results", { action: "results", sessionIds: [seededId] }, undefined, undefined, baseCtx());
  assert.equal(results.isError, false);
  assert.equal(results.details.results[0].snapshot.id, seededId);

  const removed = await tool.execute("c-remove", { action: "remove", sessionIds: [seededId] }, undefined, undefined, baseCtx());
  assert.equal(removed.isError, false);
  assert.equal(removed.details.summary.removed, 1);
  assert.deepEqual(manager.listSessions(), []);
});

test("recursive foreground subagent spawn completes with a single shared queue slot", async () => {
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const runner = async (ctx: any, agent: any) => {
    agent.attach(makeSession());
    if (agent.spawn.prompt === "spawn-child") {
      const tool = captureChildTool(manager, registry, agent);
      const result = await tool.execute(
        "child-call",
        { action: "run", tasks: [{ agent: "worker", prompt: "leaf" }] },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, false);
      return completedRun(agent, "parent-done");
    }
    return completedRun(agent, "leaf-done");
  };

  const manager = makeManager(registry as any, 1, runner);

  const results = await Promise.race([
    run(manager,baseCtx(), undefined, [{ kind: "spawn", agent: "worker", prompt: "spawn-child" }]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("recursive run timed out")), 100)),
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(manager.listSessions().length, 2);
});

test("recursive foreground subagent chain can exceed the shared queue cap without deadlocking", async () => {
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const runner = async (ctx: any, agent: any) => {
    agent.attach(makeSession());
    if (agent.spawn.prompt.startsWith("spawn-")) {
      const remaining = Number(agent.spawn.prompt.slice("spawn-".length));
      const tool = captureChildTool(manager, registry, agent);
      const result = await tool.execute(
        `child-${remaining}`,
        { action: "run", tasks: [{ agent: "worker", prompt: remaining > 1 ? `spawn-${remaining - 1}` : "leaf" }] },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, false);
    }
    return completedRun(agent, `done:${agent.spawn.prompt}`);
  };

  const manager = makeManager(registry as any, 1, runner);

  const results = await Promise.race([
    run(manager,baseCtx(), undefined, [{ kind: "spawn", agent: "worker", prompt: "spawn-3" }]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("recursive chain timed out")), 100)),
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(manager.listSessions().length, 4);
});

test("recursive subagent spawn: root → child → grandchild all live under one shared manager with correct parent links", async () => {
  // Custom runner that simulates each Agent spawning through its child-session tool.
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const recordedParents: Record<string, string | undefined> = {};
  const runner = async (ctx: any, agent: any) => {
    recordedParents[agent.id] = agent.parentId;
    agent.attach(makeSession());
    if (agent.spawn.prompt === "spawn-child") {
      const tool = captureChildTool(manager, registry, agent);
      const result = await tool.execute(
        "c-call",
        { action: "run", tasks: [{ agent: "worker", prompt: "spawn-grandchild" }] },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, false);
      return completedRun(agent, "child-done");
    }
    if (agent.spawn.prompt === "spawn-grandchild") {
      const tool = captureChildTool(manager, registry, agent);
      const result = await tool.execute(
        "g-call",
        { action: "run", tasks: [{ agent: "worker", prompt: "leaf" }] },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, false);
      return completedRun(agent, "grandchild-done");
    }
    return completedRun(agent, "leaf-done");
  };

  const manager = makeManager(registry as any, 8, runner);

  const results = await run(manager,baseCtx(), undefined, [{ kind: "spawn", agent: "worker", prompt: "spawn-child" }]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], "parentSessionId"), false, "root result has no parent");

  // Three distinct ids should have been seen by the runner — root, child, grandchild.
  const ids = Object.keys(recordedParents);
  assert.equal(ids.length, 3, `expected 3 agent runs, got ${ids.length}`);

  const rootIds = ids.filter(id => recordedParents[id] === undefined);
  assert.equal(rootIds.length, 1);
  const rootId = rootIds[0];

  const childIds = ids.filter(id => recordedParents[id] === rootId);
  assert.equal(childIds.length, 1, "exactly one child should point to root");
  const childId = childIds[0];

  const grandchildIds = ids.filter(id => recordedParents[id] === childId);
  assert.equal(grandchildIds.length, 1, "exactly one grandchild should point to child");
  const grandchildId = grandchildIds[0];

  // All three retained sessions visible from the root manager with the expected linkage.
  const sessions = manager.listSessions();
  assert.equal(sessions.length, 3);
  const sessionsById = new Map(sessions.map(s => [s.id, s]));
  assert.equal(sessionsById.get(rootId)?.parentSessionId, undefined);
  assert.equal(sessionsById.get(childId)?.parentSessionId, rootId);
  assert.equal(sessionsById.get(grandchildId)?.parentSessionId, childId);
});

test("child subagent tool does not reload settings or rebuild the registry on each call", async () => {
  let settingsCalls = 0;
  let registryReloads = 0;
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project" }]]),
    reload: async () => { registryReloads += 1; },
    summarizeAgent: () => "worker",
  };
  const manager = makeManager(registry as any, 2, async (_c: any, a: any) => { a.attach(makeSession()); return completedRun(a, "ok"); });
  const parent = new Agent("parent-7", baseAgentConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);

  const tool = makeChildSubagentTool({
    manager, registry: registry as any, parent,
    getCurrentSettings: () => { settingsCalls += 1; return DEFAULT_SUBAGENT_SETTINGS; },
  });

  await tool.execute("c1", { action: "list" }, undefined, undefined, baseCtx());
  await tool.execute("c2", { action: "agents" }, undefined, undefined, baseCtx());

  assert.equal(registryReloads, 0, "child invocations must not reload the registry");
  assert.ok(settingsCalls >= 1, "child invocations should read current settings");
});
