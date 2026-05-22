import { test } from "vitest";
import assert from "node:assert/strict";

import { completedRun } from "../../src/domain/agent-finalize.js";
import { Agent } from "../../src/domain/agent.js";
import { RunGroup } from "../../src/runtime/run-group.js";
import { projectAgentView } from "../../src/view/project-agent-view.js";
import { baseCtx, makeManager, makeSession } from "../helpers/runtime.js";

const testAgentConfig = { name: "helper", description: "d", systemPrompt: "s", source: "project" as const, resumable: false };

function makeAgent(id: string, parentSessionId?: string): Agent {
  return new Agent(id, testAgentConfig, { kind: "spawn", agent: "helper", prompt: id }, { parentSessionId });
}

test("RunGroup.tree emits a descendant root only once", () => {
  const parent = makeAgent("parent");
  const child = makeAgent("child", "parent");
  const group = new RunGroup({
    groupId: "group",
    walkTree: rootIds => rootIds.flatMap(id => {
      if (id === "parent") return [parent, child].map(agent => projectAgentView(agent));
      if (id === "child") return [projectAgentView(child)];
      return [];
    }),
  });

  group.addAgent(parent, 0, false);
  group.addAgent(child, 1, true);

  assert.deepEqual(group.tree().map(view => view.id), ["parent", "child"]);
});

test("BatchRun emits grouped progress rows in input order including unknown agents", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = makeManager(registry as any, 2, runner);
  const snapshots: any[] = [];

  const results = await manager.run(
    baseCtx(),
    undefined,
    [
      { kind: "spawn", agent: "helper", prompt: "one" },
      { kind: "spawn", agent: "missing", prompt: "two" },
      { kind: "spawn", agent: "helper", prompt: "three" },
    ],
    update => snapshots.push(update.sessions),
  );

  assert.deepEqual(results.map(r => r.agent), ["helper", "missing", "helper"]);
  assert.deepEqual(results.map(r => r.status), ["completed", "error", "completed"]);

  const initial = snapshots[0];
  assert.equal(initial.length, 3);
  assert.deepEqual(
    initial.map((row: any) => [row.config.name, row.status.kind === "done" ? row.status.outcome : row.status.kind, row.inputIndex]),
    [["helper", "queued", 0], ["missing", "error", 1], ["helper", "queued", 2]],
  );
  assert.match(initial[1].status.snippet, /Unknown agent: missing/);
});

test("BatchRun keeps emitting active batch updates for spinner animation even without agent events", async () => {
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  let finish: () => void;
  const blocker = new Promise<void>(resolve => { finish = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await blocker;
    return completedRun(agent, "done");
  };
  const manager = makeManager(registry as any, 1, runner);
  const snapshots: any[] = [];

  const pending = manager.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "work" }],
    update => snapshots.push(update.sessions[0]),
  );

  await new Promise(resolve => setTimeout(resolve, 280));
  finish!();
  await pending;

  assert.equal(snapshots[0].status.kind, "queued");
  assert.ok(snapshots.filter(s => s.status.kind === "running").length >= 2);
  assert.equal(snapshots.at(-1).status.outcome, "completed");
});

test("BatchRun emits live agent progress with the right transitions", async () => {
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project", model: "test/model" }]]),
  };
  let emit: ((e: any) => void) | undefined;
  const session = { messages: [], subscribe(handler: any) { emit = handler; return () => {}; }, prompt: async () => {}, abort: () => {} };
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(session);
    emit!({ type: "message_start" });
    emit!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working through the delegated task" } });
    emit!({ type: "tool_execution_start", toolName: "read" });
    emit!({ type: "turn_end" });
    emit!({ type: "tool_execution_end" });
    return completedRun(agent, "done");
  };
  const manager = makeManager(registry as any, 1, runner);
  const snapshots: any[] = [];

  const results = await manager.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "Summarize the project status for the parent agent." }],
    update => snapshots.push(update.sessions[0]),
  );

  assert.equal(results[0].status, "completed");
  assert.ok(snapshots.length >= 4);
  assert.equal(snapshots[0].status.kind, "queued");
  assert.equal(snapshots[0].config.name, "helper");

  assert.ok(snapshots.some(s => s.status.kind === "running"));
  assert.ok(snapshots.some(s => s.activity.toolHistory.some((tool: any) => tool.name === "read" && tool.completedAt === undefined)));
  assert.ok(snapshots.some(s => s.activity.turns === 1));
  assert.ok(snapshots.some(s => s.activity.messageSnippet === "working through the delegated task"));
  assert.equal(snapshots.at(-1).status.outcome, "completed");
});

test("BatchRun throttles live message snippets while lifecycle updates are immediate", async () => {
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  let emit: ((e: any) => void) | undefined;
  const session = { messages: [], subscribe(handler: any) { emit = handler; return () => {}; }, prompt: async () => {}, abort: () => {} };
  let finish: () => void;
  const allowFinish = new Promise<void>(resolve => { finish = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(session);
    emit!({ type: "message_start" });
    emit!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one" } });
    emit!({ type: "message_start" });
    emit!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "two" } });
    emit!({ type: "message_start" });
    emit!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "three" } });
    await allowFinish;
    return completedRun(agent, "done");
  };
  const manager = makeManager(registry as any, 1, runner);
  const snapshots: any[] = [];
  const pending = manager.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "work" }],
    update => snapshots.push(update.sessions[0]),
  );

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(snapshots.some(s => s.status.kind === "running"));
  assert.equal(snapshots.filter(s => s.activity.messageSnippet).length, 0);

  await new Promise(resolve => setTimeout(resolve, 130));
  const withMessage = snapshots.filter(s => s.activity.messageSnippet);
  assert.equal(withMessage.length, 1);
  assert.equal(snapshots.at(-1).activity.messageSnippet, "three");

  finish!();
  await pending;
});
