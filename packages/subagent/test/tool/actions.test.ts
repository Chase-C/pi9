import { test } from "vitest";
import assert from "node:assert/strict";
import { agentsAction, cancelAction, inspectAction, joinAction, listAction, removeAction, resumeAction, spawnAction, steerAction } from "../../src/tool.js";

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
  runtime: {
    inspectRuns: (ids: any[]) => ids.map(target => ({ conversationId, snapshot: { ...snapshot().runs[0], runId: target } })),
    runLineage: (target: any) => ({ rootRunId: target, depth: 0 }),
    ...manager,
  },
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

test("agents returns definitions in the common response envelope", () => {
  const agent = { name: "helper", description: "Helps", source: "user" };
  const result = agentsAction({
    runtime: {} as any,
    agentRegistry: { agents: new Map([["helper", agent]]) } as any,
  }, { action: "agents" });

  assert.deepEqual(json(result), {
    action: "agents",
    results: [agent],
  });
});

test("spawn preserves receipt order and includes labels", async () => {
  const tasks = [
    { kind: "spawn" as const, agent: "helper", prompt: "valid", label: "valid task" },
    { kind: "spawn" as const, agent: "missing", prompt: "unknown agent", label: "missing agent" },
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
  const result = await spawnAction(deps(manager), { action: "spawn", spawns: tasks }, {} as any);
  assert.deepEqual(received, tasks);
  assert.deepEqual(json(result), {
    action: "spawn",
    results: [
      { ok: true, data: { label: "valid task", conversationId, runId } },
      { ok: false, agent: "missing", label: "missing agent", error: "Unknown agent: missing." },
    ],
  });
  assert.equal(result.isError, false);
});

test("spawn and resume return independent ordered receipt arrays", async () => {
  const received: any[] = [];
  const manager = {
    startRun: (_ctx: any, [task]: any[]) => {
      received.push(task);
      const start = { ok: true as const, inputIndex: 0, conversationId, runId };
      return { starts: [start], completion: Promise.resolve([start]) };
    },
    listConversations: () => [{ ...snapshot(), label: "retained task" }],
  };

  const spawned = await spawnAction(deps(manager), {
    action: "spawn",
    spawns: [{ kind: "spawn", agent: "helper", prompt: "new" }],
  }, {} as any);
  const resumed = await resumeAction(deps(manager), {
    action: "resume",
    resumes: [{ kind: "resume", conversationId, prompt: "continue" }],
  }, {} as any);

  assert.deepEqual(received.map(task => task.kind), ["spawn", "resume"]);
  assert.deepEqual(json(spawned), {
    action: "spawn",
    results: [{ ok: true, data: { conversationId, runId } }],
  });
  assert.deepEqual(json(resumed), {
    action: "resume",
    results: [{ ok: true, data: { label: "retained task", conversationId, runId } }],
  });
});

test("resume failures retain their conversation identity", async () => {
  const error = `Conversation ${conversationId} cannot be resumed.`;
  const manager = {
    startRun: () => {
      const start = { ok: false as const, inputIndex: 0, error };
      return { starts: [start], completion: Promise.resolve([start]) };
    },
    listConversations: () => [snapshot({ kind: "done", outcome: "aborted", completedAt: 2, error: "Run cancelled." })],
  };

  const result = await resumeAction(deps(manager), {
    action: "resume",
    resumes: [{ kind: "resume", conversationId, prompt: "continue" }],
  }, {} as any);

  assert.deepEqual(json(result), { action: "resume", results: [{ ok: false, conversationId, error }] });
});

test("spawn returns task parse failures while starting valid siblings", async () => {
  const tasks = [
    { kind: "spawn" as const, agent: "helper", prompt: "first" },
    { error: "Spawn task agent must be a non-empty string.", label: "invalid spawn" },
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

  const result = await spawnAction(deps(manager), { action: "spawn", spawns: tasks }, {} as any);

  assert.deepEqual(json(result), {
    action: "spawn",
    results: [
      { ok: true, data: { conversationId, runId } },
      { ok: false, label: "invalid spawn", error: tasks[1].error },
      { ok: false, agent: "missing", error: "Unknown agent: missing." },
    ],
  });
  assert.equal(result.isError, false);
});

test("steer sends multiple messages in input order", async () => {
  const secondRunId = "assemble-abruptly" as any;
  const received: any[] = [];
  const manager = {
    steerRun: async (target: any, prompt: string) => {
      received.push([target, prompt]);
      return { conversationId, runId: target, steer: { id: received.length, state: "queued", acceptedAt: received.length } };
    },
    listConversations: () => [snapshot()],
  };
  const result = await steerAction(deps(manager), {
    action: "steer",
    messages: [
      { kind: "steer", runId, message: "first" },
      { kind: "steer", runId: secondRunId, message: "second" },
      { kind: "steer", runId, message: "third" },
    ],
  });

  assert.deepEqual(received, [[runId, "first"], [secondRunId, "second"], [runId, "third"]]);
  const response = json(result);
  assert.equal(response.action, "steer");
  assert.deepEqual(response.results.map((entry: any) => entry.data.runId), [runId, secondRunId, runId]);
  assert.deepEqual(response.results.map((entry: any) => entry.data.steer.id), [1, 2, 3]);
  assert.deepEqual((result.details as any).tasks.map((task: any) => task.kind), ["steer", "steer", "steer"]);
  assert.deepEqual((result.details as any).tasks.map((task: any) => task.steer.id), [1, 2, 3]);
});

test("steer isolates failures from sibling messages", async () => {
  const secondRunId = "assemble-abruptly" as any;
  const manager = {
    steerRun: async (target: any) => {
      if (target === runId) throw new Error("Run is queued and cannot be steered.");
      return { conversationId, runId: target };
    },
    listConversations: () => [snapshot()],
  };
  const result = await steerAction(deps(manager), {
    action: "steer",
    messages: [
      { kind: "steer", runId, message: "first" },
      { kind: "steer", runId: secondRunId, message: "second" },
    ],
  });

  assert.deepEqual(json(result), {
    action: "steer",
    results: [
      { ok: false, runId, error: "Run is queued and cannot be steered." },
      { ok: true, data: { conversationId, runId: secondRunId } },
    ],
  });
});

test("cancel aborts an exact run while retaining its identity", async () => {
  const manager = {
    cancelRun: async (target: any) => {
      assert.equal(target, runId);
      return { conversationId, runId: target, status: "aborted" };
    },
    listConversations: () => [snapshot({ kind: "done", outcome: "aborted", completedAt: 2, error: "Run cancelled." })],
  };

  const result = await cancelAction(deps(manager), { action: "cancel", runIds: [runId] });

  assert.equal(result.isError, false);
  assert.deepEqual(json(result), {
    action: "cancel",
    results: [{ ok: true, data: { conversationId, runId, status: "aborted" } }],
  });
});

test("cancel starts valid targets concurrently while preserving input order", async () => {
  const secondRunId = "assemble-abruptly" as any;
  const started: any[] = [];
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
  const manager = {
    cancelRun: async (target: any) => {
      started.push(target);
      if (target === runId) await firstPending;
      return { conversationId, runId: target, status: "aborted" };
    },
    listConversations: () => [],
  };

  const resultPromise = cancelAction(deps(manager), {
    action: "cancel",
    runIds: [runId, secondRunId],
  });

  try {
    assert.deepEqual(started, [runId, secondRunId]);
  } finally {
    releaseFirst();
  }

  assert.deepEqual(json(await resultPromise), {
    action: "cancel",
    results: [
      { ok: true, data: { conversationId, runId, status: "aborted" } },
      { ok: true, data: { conversationId, runId: secondRunId, status: "aborted" } },
    ],
  });
});

test("cancel isolates malformed and runtime failures from valid siblings", async () => {
  const secondRunId = "assemble-abruptly" as any;
  const manager = {
    cancelRun: async (target: any) => {
      if (target === runId) throw new Error(`Run ${target} is completed and cannot be cancelled.`);
      return { conversationId, runId: target, status: "aborted" };
    },
    listConversations: () => [],
  };

  const result = await cancelAction(deps(manager), {
    action: "cancel",
    runIds: [
      { runId: "not-an-id", error: "invalid runId format" },
      runId,
      secondRunId,
    ],
  });

  assert.deepEqual(json(result), {
    action: "cancel",
    results: [
      { ok: false, runId: "not-an-id", error: "invalid runId format" },
      { ok: false, runId, error: `Run ${runId} is completed and cannot be cancelled.` },
      { ok: true, data: { conversationId, runId: secondRunId, status: "aborted" } },
    ],
  });
});

test("inspect returns bounded progress without terminal output", () => {
  const running: any = snapshot().runs[0];
  running.activity = {
    phase: "thinking", messageSnippet: "working ".repeat(100), turns: 2, compactions: 1,
    toolHistory: [1, 2, 3, 4].map(index => ({ id: `t${index}`, name: `tool${index}`, startedAt: index, inputSummary: "argument ".repeat(30) })),
  };
  running.steers = [1, 2, 3, 4, 5, 6].map(id => ({ id, state: "processed", acceptedAt: id }));
  const manager = {
    inspectRuns: (ids: any[]) => {
      assert.deepEqual(ids, [runId]);
      return [{ conversationId, snapshot: running }];
    },
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
    conversation: () => ({
      ...snapshot(),
      requestedOverrides: { model: "requested/model", thinking: "high" },
      effectiveConfig: { model: "effective/model", thinking: "medium", cwd: "/work", skills: ["review"], tools: ["read"] },
    }),
    runLineage: () => ({ parentRunId: "branch-boldly", rootRunId: "start-safely", depth: 2 }),
  };
  const result = inspectAction(deps(manager), { action: "inspect", runIds: [runId] });
  const response = json(result);
  assert.equal(response.action, "inspect");
  const [{ data: entry }] = response.results;

  assert.equal(entry.status, "running");
  assert.deepEqual(
    { parentRunId: entry.parentRunId, rootRunId: entry.rootRunId, depth: entry.depth },
    { parentRunId: "branch-boldly", rootRunId: "start-safely", depth: 2 },
  );
  assert.equal(entry.phase, "thinking");
  assert.deepEqual(entry.requestedOverrides, { model: "requested/model", thinking: "high" });
  assert.deepEqual(entry.effectiveConfig, {
    model: "effective/model", thinking: "medium", cwd: "/work", skills: ["review"], tools: ["read"],
  });
  assert.equal(entry.turns, 2);
  assert.equal(entry.compactions, 1);
  assert.ok(entry.messageSnippet.length <= 500);
  assert.deepEqual(entry.recentTools.map((tool: any) => tool.tool), ["tool4", "tool3", "tool2"]);
  assert.ok(entry.recentTools.every((tool: any) => tool.summary.length <= 160));
  assert.deepEqual(entry.steers.map((steer: any) => steer.id), [2, 3, 4, 5, 6]);
  assert.equal("output" in entry, false);
});

test("inspect shows requested overrides before effective configuration is available", () => {
  const manager = {
    inspectRuns: () => [{ conversationId, snapshot: snapshot().runs[0] }],
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
    conversation: () => ({ ...snapshot(), requestedOverrides: { model: "requested/model", thinking: "high" } }),
    runLineage: () => ({ rootRunId: runId, depth: 0 }),
  };

  const [{ data: entry }] = json(inspectAction(deps(manager), { action: "inspect", runIds: [runId] })).results;

  assert.deepEqual(entry.requestedOverrides, { model: "requested/model", thinking: "high" });
  assert.equal("effectiveConfig" in entry, false);
});

test("inspect isolates malformed and unknown targets from valid siblings", () => {
  const unknownRunId = "assemble-abruptly" as any;
  const malformed = { runId: "not-an-id", error: "invalid runId format" };
  const manager = {
    inspectRuns: ([target]: any[]) => {
      if (target === unknownRunId) throw new Error(`Unknown run: ${target}.`);
      return [{ conversationId, snapshot: snapshot().runs[0] }];
    },
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
  };

  const result = inspectAction(deps(manager), {
    action: "inspect",
    runIds: [runId, malformed, unknownRunId],
  });

  const entries = json(result).results;
  assert.equal(entries[0].data.runId, runId);
  assert.deepEqual(entries[1], { ok: false, runId: "not-an-id", error: "invalid runId format" });
  assert.deepEqual(entries[2], { ok: false, runId: unknownRunId, error: `Unknown run: ${unknownRunId}.` });
  assert.equal(result.isError, false);
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
  const entry = json(result).results[0].data;
  assert.equal("requestedOverrides" in entry, false);
  assert.equal("effectiveConfig" in entry, false);
  assert.equal(entry.recentTools[0].status, "interrupted");
});

test("inspect includes a bounded diagnostic for a failed run", () => {
  const terminal: any = snapshot({
    kind: "done", outcome: "error", completedAt: 2, startedAt: 1, error: "Model request failed.",
  }).runs[0];
  const manager = {
    inspectRuns: () => [{ conversationId, snapshot: terminal }],
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
  };

  const result = inspectAction(deps(manager), { action: "inspect", runIds: [runId] });

  assert.equal(result.isError, false);
  assert.equal(json(result).results[0].data.errorSnippet, "Model request failed.");
});

test("inspect bounds diagnostics for every terminal outcome with an error", () => {
  for (const outcome of ["error", "interrupted", "aborted", "skipped"] as const) {
    const terminal: any = snapshot({
      kind: "done", outcome, completedAt: 2, startedAt: 1, error: "Failure \n".repeat(100),
    }).runs[0];
    const manager = {
      inspectRuns: () => [{ conversationId, snapshot: terminal }],
      conversationDisplay: () => ({ conversationId, agentName: "helper" }),
    };

    const [{ data: entry }] = json(inspectAction(deps(manager), { action: "inspect", runIds: [runId] })).results;

    assert.equal(entry.errorSnippet.length, 500);
    assert.doesNotMatch(entry.errorSnippet, /\s{2,}/);
    assert.match(entry.errorSnippet, /…$/);
  }
});

test("list groups by conversation and retains only matching runs", () => {
  let calls = 0;
  const running = snapshot();
  const completed = snapshot({ kind: "done", outcome: "completed", completedAt: 2 });
  completed.runs = [running.runs[0], { ...completed.runs[0], runId: "assemble-abruptly" as any, kind: "resume" }];
  const manager = {
    listConversations: () => {
      calls++;
      return [completed];
    },
    runLineage: (target: any) => ({ parentRunId: "branch-boldly", rootRunId: "start-safely", depth: target === runId ? 1 : 2 }),
  };
  const result = listAction(deps(manager), { action: "list", status: ["completed"] });
  assert.equal(calls, 1);
  const response = json(result);
  assert.equal(response.action, "list");
  assert.deepEqual(response.results, [{
    conversationId,
    agent: "helper",
    createdAt: 1,
    canResume: false,
    runs: [{
      runId: "assemble-abruptly",
      kind: "resume",
      status: "completed",
      createdAt: 1,
      parentRunId: "branch-boldly",
      rootRunId: "start-safely",
      depth: 2,
    }],
  }]);
  assert.doesNotMatch(result.content[0].text, /output/);

  const empty = listAction(deps(manager), { action: "list", status: ["error"] });
  assert.deepEqual(json(empty), { action: "list", results: [] });
  assert.equal(calls, 2);
});

test("remove forwards only the explicit conversation batch", async () => {
  let received: any;
  const summary = { removed: 1, conversationIds: [conversationId], errors: [] };
  const result = await removeAction(deps({
    removeConversations: async (ids: any) => {
      received = ids;
      return summary;
    },
  }), { action: "remove", conversationIds: [conversationId] });
  assert.deepEqual(received, [conversationId]);
  assert.deepEqual(json(result), {
    action: "remove",
    results: [{ ok: true, data: { conversationId, removed: true } }],
  });
});

test("remove preserves ordered malformed and runtime failures without hiding valid siblings", async () => {
  const unknownConversationId = "silent-meadow" as any;
  const malformed = { conversationId: "not-an-id", error: "invalid conversationId format" };
  let received: any;
  const result = await removeAction(deps({
    removeConversations: async (ids: any) => {
      received = ids;
      return {
        removed: 1,
        conversationIds: [conversationId],
        errors: [{ conversationId: unknownConversationId, error: `Unknown conversation: ${unknownConversationId}.` }],
      };
    },
  }), { action: "remove", conversationIds: [conversationId, malformed, unknownConversationId] });

  assert.deepEqual(received, [conversationId, unknownConversationId]);
  assert.deepEqual(json(result), {
    action: "remove",
    results: [
      { ok: true, data: { conversationId, removed: true } },
      { ok: false, conversationId: "not-an-id", error: "invalid conversationId format" },
      { ok: false, conversationId: unknownConversationId, error: `Unknown conversation: ${unknownConversationId}.` },
    ],
  });
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
  assert.deepEqual(json(result), {
    action: "join",
    results: [{
      ok: true,
      data: { conversationId, runId, status: "error", error: "child failed" },
    }],
  });
  assert.equal(released, 1);
  assert.equal(acknowledged, 1);
  assert.ok(updates.length >= 1);
  assert.deepEqual(JSON.parse(updates[0].content[0].text), {
    action: "join",
    results: [{ ok: true, data: { conversationId, runId, status: "error", error: "child failed" } }],
  });
});

test("join projects elapsed time, turns, and tokens for rendering", async () => {
  const conversation: any = snapshot({ kind: "done", outcome: "completed", startedAt: 1_000, completedAt: 13_400 });
  conversation.runs[0].activity.turns = 3;
  conversation.runs[0].usage = {
    input: 20_000,
    output: 4_000,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 24_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const entries = [{ conversationId, runId, status: conversation.runs[0].status }];
  const manager = {
    bindJoin: () => joinBinding(entries),
    onConversationUpdate: () => () => {},
    listConversations: () => [conversation],
    runner: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() },
  };

  const result = await joinAction(deps(manager), { action: "join", runIds: [runId] }, undefined, undefined);

  assert.deepEqual((result.details as any).runs[0], {
    conversationId,
    runId,
    status: "completed",
    agent: "helper",
    kind: "spawn",
    prompt: "x",
    elapsedMs: 12_400,
    turns: 3,
    tokens: 24_000,
    activity: [],
    joins: [],
    background: [],
    joinToolCallIds: [],
  });
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
  assert.deepEqual(json(await promise).results.map((entry: any) => entry.data.runId), [runId, secondRunId]);
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
  assert.deepEqual(json(result), {
    action: "join",
    error: "Join cancelled by caller.",
  });
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

test("nested join records one binding for valid siblings and returns invalid targets in place", async () => {
  const childRunId = "assemble-abruptly" as any;
  const unknownRunId = "capture-keenly" as any;
  let boundIds: any[] = [];
  const manager = {
    inspectRuns: ([target]: any[]) => {
      if (target === unknownRunId) throw new Error(`Unknown run: ${target}.`);
      return [{ conversationId, snapshot: { ...snapshot().runs[0], runId: target } }];
    },
    bindNestedJoin: (_owner: any, ids: any[]) => {
      boundIds = ids;
      return {
        ...joinBinding([{ conversationId, runId: childRunId, status: { kind: "done", outcome: "completed", completedAt: 2 } }]),
        interrupt: () => {},
      };
    },
    onConversationUpdate: () => () => {},
    scheduler: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() },
  };
  const result = await joinAction({
    ...deps(manager),
    parent: { conversationId, runId: () => runId },
  }, {
    action: "join",
    runIds: [
      { runId: "not-an-id", error: "invalid runId format" },
      childRunId,
      unknownRunId,
    ],
  }, undefined, undefined);

  assert.deepEqual(boundIds, [childRunId]);
  assert.deepEqual(json(result).results, [
    { ok: false, runId: "not-an-id", error: "invalid runId format" },
    { ok: true, data: { conversationId, runId: childRunId, status: "completed" } },
    { ok: false, runId: unknownRunId, error: `Unknown run: ${unknownRunId}.` },
  ]);
});

test("a bound join acknowledges an aborted outcome after cancellation", async () => {
  let resolve!: () => void;
  let acknowledged = 0;
  const entries = [{
    conversationId,
    runId,
    status: {
      kind: "done",
      outcome: "aborted",
      completedAt: 2,
      error: "Run cancelled.",
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
  assert.deepEqual(json(await pending).results, [{
    ok: true,
    data: { conversationId, runId, status: "aborted", error: "Run cancelled." },
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

test("join isolates malformed and unknown targets from valid siblings", async () => {
  const unknownRunId = "assemble-abruptly" as any;
  const malformed = { runId: "not-an-id", error: "join received invalid runId format 'not-an-id'." };
  const entries = [{ conversationId, runId, status: { kind: "done", outcome: "completed", completedAt: 2, output: "done" } }];
  let subscribed = false;
  const manager = {
    inspectRuns: ([target]: any[]) => {
      if (target === unknownRunId) throw new Error(`Unknown run: ${target}.`);
      return [{ conversationId, snapshot: snapshot().runs[0] }];
    },
    bindJoin: (ids: any[]) => {
      assert.deepEqual(ids, [runId]);
      return joinBinding(entries);
    },
    onConversationUpdate: () => {
      subscribed = true;
      return () => {};
    },
  };

  const result = await joinAction(
    deps(manager),
    { action: "join", runIds: [runId, malformed, unknownRunId] },
    undefined,
    undefined,
  );

  assert.equal(result.isError, false);
  assert.equal(subscribed, true);
  assert.deepEqual(json(result).results, [
    { ok: true, data: { conversationId, runId, status: "completed", output: "done" } },
    { ok: false, runId: malformed.runId, error: malformed.error },
    { ok: false, runId: unknownRunId, error: `Unknown run: ${unknownRunId}.` },
  ]);
});

test("join returns item errors without binding when no target resolves", async () => {
  let subscribed = false;
  const manager = {
    inspectRuns: () => { throw new Error("Unknown run: assemble-abruptly."); },
    bindJoin: () => { throw new Error("must not bind"); },
    onConversationUpdate: () => {
      subscribed = true;
      return () => {};
    },
  };
  const result = await joinAction(
    deps(manager),
    { action: "join", runIds: [
      { runId: "not-an-id", error: "invalid runId format" },
      "assemble-abruptly" as any,
    ] },
    undefined,
    undefined,
  );
  assert.equal(result.isError, false);
  assert.equal(subscribed, false);
  assert.deepEqual(json(result).results, [
    { ok: false, runId: "not-an-id", error: "invalid runId format" },
    { ok: false, runId: "assemble-abruptly", error: "Unknown run: assemble-abruptly." },
  ]);
});
