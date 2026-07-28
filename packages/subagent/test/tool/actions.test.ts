import { test } from "vitest";
import assert from "node:assert/strict";
import { dispatchAction, inspectAction, joinAction, listAction, removeAction } from "../../src/tool.js";

const conversationId = "amber-acorn" as any;
const runId = "adapt-ably" as any;
const snapshot = (status: any = { kind: "running", startedAt: 1 }) => ({
  conversationId,
  createdAt: 1,
  config: { name: "helper" },
  runs: [{
    runId,
    kind: "spawn",
    prompt: "x",
    createdAt: 1,
    status,
    activity: { turns: 0, compactions: 0, toolHistory: [] },
    usage: undefined,
    observerCount: 1,
    acknowledged: false,
  }],
  currentRun: undefined,
  canResume: false,
});
const deps = (manager: any) => ({
  runtime: manager,
  agentRegistry: { agents: new Map(), summarizeAgent: () => "" },
}) as any;
const json = (result: any) => JSON.parse(result.content[0].text);
const joinBinding = (
  entries: any[],
  completion: Promise<void> = Promise.resolve(),
  hooks: { acknowledge?: () => void; release?: () => void } = {},
) => ({
  completion,
  project: () => entries,
  acknowledge: hooks.acknowledge ?? (() => {}),
  release: hooks.release ?? (() => {}),
});

test("dispatch forwards validated tasks and preserves outcome order", async () => {
  const tasks = [
    { kind: "spawn" as const, agent: "helper", prompt: "valid" },
    { kind: "spawn" as const, agent: "missing", prompt: "unknown agent" },
  ];
  const received: any[] = [];
  const manager = {
    startRun: (_ctx: any, batch: any[]) => {
      received.push(batch[0]);
      const start = batch[0].agent === "helper"
        ? { ok: true as const, inputIndex: 0, conversationId, runId }
        : { ok: false as const, inputIndex: 0, error: "Unknown agent: missing." };
      return { starts: [start], completion: Promise.resolve([start]) };
    },
    listConversations: () => [],
  };
  const result = await dispatchAction(deps(manager), { action: "dispatch", tasks }, {} as any);
  assert.deepEqual(received, tasks);
  assert.deepEqual(json(result), [
    { ok: true, inputIndex: 0, conversationId, runId },
    { ok: false, inputIndex: 1, error: "Unknown agent: missing." },
  ]);
  assert.equal(result.isError, false);
});

test("dispatch returns task parse failures while starting valid siblings", async () => {
  const tasks = [
    { kind: "spawn" as const, agent: "helper", prompt: "first" },
    { error: "Task must carry exactly one of agent (spawn), conversationId (resume), or runId (steer)." },
    { kind: "spawn" as const, agent: "missing", prompt: "third" },
  ];
  const manager = {
    startRun: (_ctx: any, received: any[]) => {
      const start = received[0].agent === "helper"
        ? { ok: true as const, inputIndex: 0, conversationId, runId }
        : { ok: false as const, inputIndex: 0, error: "Unknown agent: missing." };
      return { starts: [start], completion: Promise.resolve([start]) };
    },
    listConversations: () => [],
  };

  const result = await dispatchAction(deps(manager), { action: "dispatch", tasks }, {} as any);

  assert.deepEqual(json(result), [
    { ok: true, inputIndex: 0, conversationId, runId },
    { ok: false, inputIndex: 1, error: tasks[1].error },
    { ok: false, inputIndex: 2, error: "Unknown agent: missing." },
  ]);
  assert.equal(result.isError, false);
});

test("dispatch steers multiple runs in input order", async () => {
  const secondRunId = "assemble-abruptly" as any;
  const received: any[] = [];
  const manager = {
    steerRun: async (target: any, prompt: string) => {
      received.push([target, prompt]);
      return { conversationId, runId: target };
    },
    listConversations: () => [snapshot()],
  };
  const result = await dispatchAction(deps(manager), {
    action: "dispatch",
    tasks: [
      { kind: "steer", runId, prompt: "first" },
      { kind: "steer", runId: secondRunId, prompt: "second" },
      { kind: "steer", runId, prompt: "third" },
    ],
  }, {} as any);

  assert.deepEqual(received, [[runId, "first"], [secondRunId, "second"], [runId, "third"]]);
  assert.deepEqual(json(result).map((entry: any) => entry.runId), [runId, secondRunId, runId]);
  assert.deepEqual((result.details as any).tasks.map((task: any) => task.kind), ["steer", "steer", "steer"]);
});

test("dispatch isolates steering failures from sibling tasks", async () => {
  const secondRunId = "assemble-abruptly" as any;
  const manager = {
    steerRun: async (target: any) => {
      if (target === runId) throw new Error("Run is queued and cannot be steered.");
      return { conversationId, runId: target };
    },
    listConversations: () => [snapshot()],
  };
  const result = await dispatchAction(deps(manager), {
    action: "dispatch",
    tasks: [
      { kind: "steer", runId, prompt: "first" },
      { kind: "steer", runId: secondRunId, prompt: "second" },
    ],
  }, {} as any);

  assert.deepEqual(json(result), [
    { ok: false, inputIndex: 0, error: "Run is queued and cannot be steered." },
    { ok: true, inputIndex: 1, conversationId, runId: secondRunId },
  ]);
});

test("inspect returns bounded progress without terminal output", () => {
  const running: any = snapshot().runs[0];
  running.activity = {
    messageSnippet: "working ".repeat(100), turns: 2, compactions: 1,
    toolHistory: [1, 2, 3, 4].map(index => ({ id: `t${index}`, name: `tool${index}`, startedAt: index, inputSummary: "argument ".repeat(30) })),
  };
  const manager = {
    inspectRuns: (ids: any[]) => {
      assert.deepEqual(ids, [runId]);
      return [{ conversationId, snapshot: running }];
    },
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
  };
  const result = inspectAction(deps(manager), { action: "inspect", runIds: [runId] });
  const [entry] = json(result);

  assert.equal(entry.status, "running");
  assert.equal(entry.turns, 2);
  assert.equal(entry.compactions, 1);
  assert.ok(entry.messageSnippet.length <= 500);
  assert.deepEqual(entry.recentTools.map((tool: any) => tool.tool), ["tool4", "tool3", "tool2"]);
  assert.ok(entry.recentTools.every((tool: any) => tool.summary.length <= 160));
  assert.equal("output" in entry, false);
});

test("inspect omits terminal output and completed message text", () => {
  const terminal: any = snapshot({
    kind: "done", outcome: "completed", completedAt: 2, startedAt: 1, output: "SECRET OUTPUT",
  }).runs[0];
  terminal.activity.messageSnippet = "SECRET MESSAGE";
  terminal.activity.toolHistory = [{ id: "active-tool", name: "bash", startedAt: 1 }];
  const manager = {
    inspectRuns: () => [{ conversationId, snapshot: terminal }],
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
  };

  const result = inspectAction(deps(manager), { action: "inspect", runIds: [runId] });

  assert.equal(result.isError, false);
  assert.doesNotMatch(result.content[0].text, /SECRET/);
  assert.equal(json(result)[0].recentTools[0].status, "interrupted");
});

test("list is output-free and filtering is pure", () => {
  let calls = 0;
  const manager = {
    listConversations: () => {
      calls++;
      return [snapshot(), snapshot({ kind: "done", outcome: "completed", completedAt: 2 })];
    },
  };
  const result = listAction(deps(manager), { action: "list", status: ["completed"] });
  assert.equal(calls, 1);
  assert.deepEqual(json(result).map((entry: any) => [
    entry.conversationId,
    entry.runId,
    entry.status,
  ]), [[conversationId, runId, "completed"]]);
});

test("remove forwards only the explicit conversation batch", () => {
  let received: any;
  const summary = { removed: 1, aborted: 0, conversationIds: [conversationId], errors: [] };
  const result = removeAction(deps({
    removeConversations: (ids: any) => {
      received = ids;
      return summary;
    },
  }), { action: "remove", conversationIds: [conversationId] });
  assert.deepEqual(received, [conversationId]);
  assert.deepEqual(json(result), summary);
});

test("join returns projected child errors as successful tool results", async () => {
  let released = 0;
  let acknowledged = 0;
  const updates: any[] = [];
  const entries = [{
    conversationId,
    runId,
    status: { kind: "done", outcome: "error", completedAt: 2, error: "child failed" },
  }];
  const manager = {
    bindJoin: (ids: any) => {
      assert.deepEqual(ids, [runId]);
      return joinBinding(entries, Promise.resolve(), {
        release: () => { released++; },
        acknowledge: () => { acknowledged++; },
      });
    },
    onConversationUpdate: () => () => {},
    runner: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() },
  };
  const result = await joinAction(
    deps(manager),
    { action: "join", runIds: [runId] },
    undefined,
    update => updates.push(update),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(json(result), [{
    conversationId,
    runId,
    status: "error",
    error: "child failed",
  }]);
  assert.equal(released, 1);
  assert.equal(acknowledged, 1);
  assert.ok(updates.length >= 1);
});

test("join streams updates and preserves binding order", async () => {
  const secondRunId = "assemble-abruptly" as any;
  let listener: any;
  const entries = [
    { conversationId, runId, status: { kind: "done", outcome: "completed", completedAt: 2 } },
    { conversationId, runId: secondRunId, status: { kind: "done", outcome: "completed", completedAt: 2 } },
  ];
  const manager = {
    bindJoin: () => joinBinding(entries),
    onConversationUpdate: (fn: any) => {
      listener = fn;
      return () => {};
    },
    runner: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() },
  };
  const updates: any[] = [];
  const promise = joinAction(
    deps(manager),
    { action: "join", runIds: [runId, secondRunId] },
    undefined,
    update => updates.push(update),
  );
  listener();
  assert.deepEqual(json(await promise).map((entry: any) => entry.runId), [runId, secondRunId]);
  assert.ok(updates.length >= 2);
});

test("caller cancellation releases join without cancelling child work", async () => {
  const controller = new AbortController();
  let released = 0;
  const manager = {
    bindJoin: () => joinBinding([], new Promise(() => {}), {
      release: () => { released++; },
    }),
    onConversationUpdate: () => () => {},
    runner: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() },
  };
  const promise = joinAction(
    deps(manager),
    { action: "join", runIds: [runId] },
    controller.signal,
    undefined,
  );
  controller.abort();
  const result = await promise;
  assert.equal(result.isError, true);
  assert.equal(released, 1);
});

test("child join binds its captured owner and suspends the parent queue slot", async () => {
  let suspended: any;
  let boundOwner: any;
  let boundToolCallId: any;
  const manager = {
    bindNestedJoin: (owner: any, _ids: any, toolCallId: any) => {
      boundOwner = owner;
      boundToolCallId = toolCallId;
      return { ...joinBinding([]), interrupt: () => {} };
    },
    onConversationUpdate: () => () => {},
    scheduler: {
      suspendAgentSlotDuring: async (id: any, fn: any) => {
        suspended = id;
        return fn();
      },
    },
  };
  await joinAction({
    ...deps(manager),
    parent: { conversationId, runId: () => runId },
  }, { action: "join", runIds: [runId] }, undefined, undefined, "join-call-1");
  assert.equal(suspended, conversationId);
  assert.deepEqual(boundOwner, { conversationId, runId });
  assert.equal(boundToolCallId, "join-call-1");
});

test("a bound join acknowledges an aborted outcome after removal", async () => {
  let resolve!: () => void;
  let acknowledged = 0;
  const entries = [{
    conversationId,
    runId,
    status: {
      kind: "done",
      outcome: "aborted",
      completedAt: 2,
      error: "Conversation removed.",
    },
  }];
  const binding = joinBinding(entries, new Promise<void>(done => { resolve = done; }), {
    acknowledge: () => { acknowledged++; },
  });
  const manager = {
    bindJoin: () => binding,
    onConversationUpdate: () => () => {},
    runner: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() },
  };
  const pending = joinAction(
    deps(manager),
    { action: "join", runIds: [runId] },
    undefined,
    undefined,
  );
  resolve();
  assert.deepEqual(json(await pending), [{
    conversationId,
    runId,
    status: "aborted",
    error: "Conversation removed.",
  }]);
  assert.equal(acknowledged, 1);
});

test("join projection retains terminal descendant joins and final detached backgrounds", async () => {
  const childRunId = "child-boldly" as any;
  const leafRunId = "leaf-quietly" as any;
  const backgroundRunId = "watch-carefully" as any;
  const done = (id: any, nestedJoins: any[] = []) => ({
    runId: id, kind: "spawn", prompt: `prompt ${id}`, createdAt: 1,
    status: { kind: "done", outcome: "completed", completedAt: 2 },
    activity: { turns: 0, compactions: 0, toolHistory: [] }, usage: undefined,
    observerCount: 0, acknowledged: false, nestedJoins,
  });
  const snapshots = new Map<any, any>([
    [runId, done(runId, [{ state: "completed", startedAt: 1, completedAt: 2, toolCallId: "root-join", targets: [{ runId: childRunId, conversationId: "child-c", status: "completed" }] }])],
    [childRunId, done(childRunId, [{ state: "completed", startedAt: 1, completedAt: 2, toolCallId: "child-join", targets: [{ runId: leafRunId, conversationId: "leaf-c", status: "completed" }] }])],
    [leafRunId, done(leafRunId)],
    [backgroundRunId, { ...done(backgroundRunId), status: { kind: "running", startedAt: 1 } }],
  ]);
  const manager = {
    bindJoin: () => joinBinding([{ conversationId, runId, status: snapshots.get(runId).status }]),
    onConversationUpdate: () => () => {},
    runSnapshot: (id: any) => snapshots.get(id),
    listConversations: () => [],
    conversationDisplay: (id: any) => ({ conversationId: id, label: id }),
    unjoinedDirectChildren: (id: any) => id === childRunId
      ? [{ runId: backgroundRunId, conversationId: "background-c" }]
      : [],
  };

  const result = await joinAction(deps(manager), { action: "join", runIds: [runId] }, undefined, undefined);
  const child = (result.details as any).runs[0].joins[0].targets[0];
  assert.equal(child.joins[0].targets[0].runId, leafRunId);
  assert.equal(child.background[0].entries[0].detachedAtFinal, true);
  assert.equal("output" in child, false);
});

test("whole-batch bind errors return before update subscription", async () => {
  let subscribed = false;
  const manager = {
    bindJoin: () => { throw new Error("Unknown or removed run"); },
    onConversationUpdate: () => {
      subscribed = true;
      return () => {};
    },
  };
  const result = await joinAction(
    deps(manager),
    { action: "join", runIds: [runId] },
    undefined,
    undefined,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown/);
  assert.equal(subscribed, false);
});
