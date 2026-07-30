import { test } from "vitest";
import assert from "node:assert/strict";
import { agentsAction, cancelAction, inspectAction, joinAction, listAction, removeAction, resumeAction, spawnAction, steerAction, type ActionDeps } from "../../src/tool.js";

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
type ActionRuntime = ActionDeps["runtime"];
type ActionRuntimeOverrides = Partial<Record<keyof ActionRuntime, any>>;
const deps = (runtime: ActionRuntimeOverrides): ActionDeps => ({
  runtime: {
    validateSubagentJoin: () => {},
    ...runtime,
  } as ActionRuntime,
  agentRegistry: { agents: new Map(), summarizeAgent: () => "" } as ActionDeps["agentRegistry"],
});
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

test("spawn returns stable subagent IDs without execution IDs", async () => {
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
      { ok: true, data: { label: "valid task", subagentId: conversationId } },
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
    resumes: [{ kind: "resume", subagentId: conversationId, prompt: "continue" }],
  }, {} as any);

  assert.deepEqual(received.map(task => task.kind), ["spawn", "resume"]);
  assert.deepEqual(json(spawned), {
    action: "spawn",
    results: [{ ok: true, data: { subagentId: conversationId } }],
  });
  assert.deepEqual(json(resumed), {
    action: "resume",
    results: [{ ok: true, data: { label: "retained task", subagentId: conversationId } }],
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
    resumes: [{ kind: "resume", subagentId: conversationId, prompt: "continue" }],
  }, {} as any);

  assert.deepEqual(json(result), { action: "resume", results: [{ ok: false, subagentId: conversationId, error }] });
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
      { ok: true, data: { subagentId: conversationId } },
      { ok: false, label: "invalid spawn", error: tasks[1].error },
      { ok: false, agent: "missing", error: "Unknown agent: missing." },
    ],
  });
  assert.equal(result.isError, false);
});

test("steer sends multiple messages in input order", async () => {
  const received: any[] = [];
  const manager = {
    steerSubagent: async (target: any, prompt: string) => {
      received.push([target, prompt]);
      return { conversationId, runId: target, steer: { id: received.length, state: "queued", acceptedAt: received.length } };
    },
    listConversations: () => [snapshot()],
  };
  const result = await steerAction(deps(manager), {
    action: "steer",
    messages: [
      { kind: "steer", subagentId: conversationId, message: "first" },
      { kind: "steer", subagentId: conversationId, message: "second" },
      { kind: "steer", subagentId: conversationId, message: "third" },
    ],
  });

  assert.deepEqual(received, [[conversationId, "first"], [conversationId, "second"], [conversationId, "third"]]);
  const response = json(result);
  assert.equal(response.action, "steer");
  assert.deepEqual(response.results.map((entry: any) => entry.data.subagentId), [conversationId, conversationId, conversationId]);
  assert.deepEqual(response.results.map((entry: any) => entry.data.steer.id), [1, 2, 3]);
  assert.deepEqual((result.details as any).tasks.map((task: any) => task.kind), ["steer", "steer", "steer"]);
  assert.deepEqual((result.details as any).tasks.map((task: any) => task.steer.id), [1, 2, 3]);
});

test("steer isolates failures from sibling messages", async () => {
  const secondSubagentId = "quiet-otter" as any;
  const manager = {
    steerSubagent: async (target: any) => {
      if (target === conversationId) throw new Error("Subagent is queued and cannot be steered.");
      return { conversationId: target, runId };
    },
    listConversations: () => [snapshot()],
  };
  const result = await steerAction(deps(manager), {
    action: "steer",
    messages: [
      { kind: "steer", subagentId: conversationId, message: "first" },
      { kind: "steer", subagentId: secondSubagentId, message: "second" },
    ],
  });

  assert.deepEqual(json(result), {
    action: "steer",
    results: [
      { ok: false, subagentId: conversationId, error: "Subagent is queued and cannot be steered." },
      { ok: true, data: { subagentId: secondSubagentId } },
    ],
  });
});

test("cancel aborts a subagent while retaining its identity", async () => {
  const manager = {
    cancelSubagent: async (target: any) => {
      assert.equal(target, conversationId);
      return { conversationId, runId, status: "aborted" };
    },
    listConversations: () => [snapshot({ kind: "done", outcome: "aborted", completedAt: 2, error: "Run cancelled." })],
  };

  const result = await cancelAction(deps(manager), { action: "cancel", subagentIds: [conversationId] });

  assert.equal(result.isError, false);
  assert.deepEqual(json(result), {
    action: "cancel",
    results: [{ ok: true, data: { subagentId: conversationId, status: "aborted" } }],
  });
});

test("cancel starts valid targets concurrently while preserving input order", async () => {
  const secondSubagentId = "quiet-otter" as any;
  const started: any[] = [];
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
  const manager = {
    cancelSubagent: async (target: any) => {
      started.push(target);
      if (target === conversationId) await firstPending;
      return { conversationId: target, runId, status: "aborted" };
    },
    listConversations: () => [],
  };

  const resultPromise = cancelAction(deps(manager), {
    action: "cancel",
    subagentIds: [conversationId, secondSubagentId],
  });

  try {
    assert.deepEqual(started, [conversationId, secondSubagentId]);
  } finally {
    releaseFirst();
  }

  assert.deepEqual(json(await resultPromise), {
    action: "cancel",
    results: [
      { ok: true, data: { subagentId: conversationId, status: "aborted" } },
      { ok: true, data: { subagentId: secondSubagentId, status: "aborted" } },
    ],
  });
});

test("cancel isolates malformed and runtime failures from valid siblings", async () => {
  const secondSubagentId = "quiet-otter" as any;
  const manager = {
    cancelSubagent: async (target: any) => {
      if (target === conversationId) throw new Error(`Subagent ${target} is completed and cannot be cancelled.`);
      return { conversationId: target, runId, status: "aborted" };
    },
    listConversations: () => [],
  };

  const result = await cancelAction(deps(manager), {
    action: "cancel",
    subagentIds: [
      { subagentId: "not-an-id", error: "invalid subagentId format" },
      conversationId,
      secondSubagentId,
    ],
  });

  assert.deepEqual(json(result), {
    action: "cancel",
    results: [
      { ok: false, subagentId: "not-an-id", error: "invalid subagentId format" },
      { ok: false, subagentId: conversationId, error: `Subagent ${conversationId} is completed and cannot be cancelled.` },
      { ok: true, data: { subagentId: secondSubagentId, status: "aborted" } },
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
    inspectSubagents: (ids: any[]) => {
      assert.deepEqual(ids, [conversationId]);
      return [{ conversationId, snapshot: running }];
    },
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
    conversation: () => ({
      ...snapshot(),
      parentConversationId: "quiet-otter",
      spawnedByRunId: "start-safely",
      requestedOverrides: { model: "requested/model", thinking: "high" },
      effectiveConfig: { model: "effective/model", thinking: "medium", cwd: "/work", skills: ["review"], tools: ["read"] },
    }),
    conversationDepth: () => 2,
  };
  const result = inspectAction(deps(manager), { action: "inspect", subagentIds: [conversationId] });
  const response = json(result);
  assert.equal(response.action, "inspect");
  const [{ data: entry }] = response.results;

  assert.equal(entry.status, "running");
  assert.deepEqual(
    { parentSubagentId: entry.parentSubagentId, depth: entry.depth },
    { parentSubagentId: "quiet-otter", depth: 2 },
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
    inspectSubagents: () => [{ conversationId, snapshot: snapshot().runs[0] }],
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
    conversation: () => ({ ...snapshot(), requestedOverrides: { model: "requested/model", thinking: "high" } }),
  };

  const [{ data: entry }] = json(inspectAction(deps(manager), { action: "inspect", subagentIds: [conversationId] })).results;

  assert.deepEqual(entry.requestedOverrides, { model: "requested/model", thinking: "high" });
  assert.equal("effectiveConfig" in entry, false);
});

test("inspect isolates malformed and unknown targets from valid siblings", () => {
  const unknownSubagentId = "quiet-otter" as any;
  const malformed = { subagentId: "not-an-id", error: "invalid subagentId format" };
  const manager = {
    inspectSubagents: ([target]: any[]) => {
      if (target === unknownSubagentId) throw new Error(`Unknown subagent: ${target}.`);
      return [{ conversationId, snapshot: snapshot().runs[0] }];
    },
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
  };

  const result = inspectAction(deps(manager), {
    action: "inspect",
    subagentIds: [conversationId, malformed, unknownSubagentId],
  });

  const entries = json(result).results;
  assert.equal(entries[0].data.subagentId, conversationId);
  assert.deepEqual(entries[1], { ok: false, subagentId: "not-an-id", error: "invalid subagentId format" });
  assert.deepEqual(entries[2], { ok: false, subagentId: unknownSubagentId, error: `Unknown subagent: ${unknownSubagentId}.` });
  assert.equal(result.isError, false);
});

test("inspect omits terminal output and completed message text", () => {
  const terminal: any = snapshot({
    kind: "done", outcome: "completed", completedAt: 2, startedAt: 1, output: "SECRET OUTPUT",
  }).runs[0];
  terminal.activity.messageSnippet = "SECRET MESSAGE";
  terminal.activity.toolHistory = [{ id: "active-tool", name: "bash", startedAt: 1 }];
  const manager = {
    inspectSubagents: () => [{ conversationId, snapshot: terminal }],
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
  };

  const result = inspectAction(deps(manager), { action: "inspect", subagentIds: [conversationId] });

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
    inspectSubagents: () => [{ conversationId, snapshot: terminal }],
    conversationDisplay: () => ({ conversationId, agentName: "helper" }),
  };

  const result = inspectAction(deps(manager), { action: "inspect", subagentIds: [conversationId] });

  assert.equal(result.isError, false);
  assert.equal(json(result).results[0].data.errorSnippet, "Model request failed.");
});

test("inspect bounds diagnostics for every terminal outcome with an error", () => {
  for (const outcome of ["error", "interrupted", "aborted", "skipped"] as const) {
    const terminal: any = snapshot({
      kind: "done", outcome, completedAt: 2, startedAt: 1, error: "Failure \n".repeat(100),
    }).runs[0];
    const manager = {
      inspectSubagents: () => [{ conversationId, snapshot: terminal }],
      conversationDisplay: () => ({ conversationId, agentName: "helper" }),
    };

    const [{ data: entry }] = json(inspectAction(deps(manager), { action: "inspect", subagentIds: [conversationId] })).results;

    assert.equal(entry.errorSnippet.length, 500);
    assert.doesNotMatch(entry.errorSnippet, /\s{2,}/);
    assert.match(entry.errorSnippet, /…$/);
  }
});

test("list filters conversation lifecycle states and retains complete run histories", () => {
  const active: any = snapshot();
  active.currentRun = active.runs[0];

  const resumable: any = snapshot({ kind: "done", outcome: "completed", completedAt: 2 });
  resumable.conversationId = "quiet-otter";
  resumable.parentConversationId = "gentle-fox";
  resumable.spawnedByRunId = "start-safely";
  resumable.canResume = true;
  resumable.runs[0].acknowledged = true;
  resumable.runs = [
    { ...resumable.runs[0], runId: "abort-quietly", status: { kind: "done", outcome: "aborted", completedAt: 2 } },
    { ...resumable.runs[0], runId: "assemble-abruptly", kind: "resume" },
  ];

  const terminal: any = snapshot({ kind: "done", outcome: "error", completedAt: 2 });
  terminal.conversationId = "closed-canyon";

  const stopping: any = snapshot({ kind: "done", outcome: "aborted", completedAt: 2 });
  stopping.conversationId = "busy-newt";
  stopping.isStopping = true;

  const manager = {
    queryConversations: () => [active, resumable, terminal, stopping],
    conversationDepth: () => 1,
  };

  const result = listAction(deps(manager), { action: "list", scope: "children", state: ["resumable"] });
  const response = json(result);
  assert.equal(response.action, "list");
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].subagentId, "quiet-otter");
  assert.equal(response.results[0].state, "resumable");
  assert.deepEqual(response.results[0].runs.map((run: any) => run.status), ["aborted", "completed"]);
  assert.doesNotMatch(result.content[0].text, /output/);

  const activeResponse = json(listAction(deps(manager), { action: "list", scope: "children", state: ["active"] }));
  assert.deepEqual(activeResponse.results.map((conversation: any) => conversation.subagentId), [conversationId, "busy-newt"]);
  assert.ok(activeResponse.results.every((conversation: any) => conversation.state === "active"));

  const awaitingResponse = json(listAction(deps(manager), { action: "list", scope: "children", state: ["awaiting_join"] }));
  assert.deepEqual(awaitingResponse.results.map((conversation: any) => conversation.subagentId), ["closed-canyon"]);
});

test("remove forwards only the explicit conversation batch", async () => {
  let received: any;
  const summary = { removed: 1, conversationIds: [conversationId], errors: [] };
  const result = await removeAction(deps({
    removeConversations: async (ids: any) => {
      received = ids;
      return summary;
    },
  }), { action: "remove", subagentIds: [conversationId] });
  assert.deepEqual(received, [conversationId]);
  assert.deepEqual(json(result), {
    action: "remove",
    results: [{ ok: true, data: { subagentId: conversationId, removed: true } }],
  });
});

test("remove preserves ordered malformed and runtime failures without hiding valid siblings", async () => {
  const unknownConversationId = "silent-meadow" as any;
  const malformed = { subagentId: "not-an-id", error: "invalid subagentId format" };
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
  }), { action: "remove", subagentIds: [conversationId, malformed, unknownConversationId] });

  assert.deepEqual(received, [conversationId, unknownConversationId]);
  assert.deepEqual(json(result), {
    action: "remove",
    results: [
      { ok: true, data: { subagentId: conversationId, removed: true } },
      { ok: false, subagentId: "not-an-id", error: "invalid subagentId format" },
      { ok: false, subagentId: unknownConversationId, error: `Unknown conversation: ${unknownConversationId}.` },
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
    bindSubagentJoin: (ids: any) => {
      assert.deepEqual(ids, [conversationId]);
      return joinBinding(entries, Promise.resolve(), {
        release: () => { released++; },
        acknowledge: () => { acknowledged++; },
      });
    },
    onConversationUpdate: () => () => {},
  };
  const result = await joinAction(
    deps(manager),
    { action: "join", subagentIds: [conversationId] },
    undefined,
    update => updates.push(update),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(json(result), {
    action: "join",
    results: [{
      ok: true,
      data: { subagentId: conversationId, status: "error", error: "child failed" },
    }],
  });
  assert.equal(released, 1);
  assert.equal(acknowledged, 1);
  assert.ok(updates.length >= 1);
  assert.deepEqual(JSON.parse(updates[0].content[0].text), {
    action: "join",
    results: [{ ok: true, data: { subagentId: conversationId, status: "error", error: "child failed" } }],
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
    bindSubagentJoin: () => joinBinding(entries),
    onConversationUpdate: () => () => {},
    listConversations: () => [conversation],
  };

  const result = await joinAction(deps(manager), { action: "join", subagentIds: [conversationId] }, undefined, undefined);

  assert.deepEqual((result.details as any).runs[0], {
    subagentId: conversationId,
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
  const secondSubagentId = "quiet-otter" as any;
  const secondRunId = "assemble-abruptly" as any;
  let listener: any;
  const entries = [
    { conversationId, runId, status: { kind: "done", outcome: "completed", completedAt: 2 } },
    { conversationId: secondSubagentId, runId: secondRunId, status: { kind: "done", outcome: "completed", completedAt: 2 } },
  ];
  const manager = {
    bindSubagentJoin: () => joinBinding(entries),
    onConversationUpdate: (fn: any) => {
      listener = fn;
      return () => {};
    },
  };
  const updates: any[] = [];
  const promise = joinAction(
    deps(manager),
    { action: "join", subagentIds: [conversationId, secondSubagentId] },
    undefined,
    update => updates.push(update),
  );
  listener();
  assert.deepEqual(json(await promise).results.map((entry: any) => entry.data.subagentId), [conversationId, secondSubagentId]);
  assert.ok(updates.length >= 2);
});

test("caller cancellation releases join without cancelling child work", async () => {
  const controller = new AbortController();
  let released = 0;
  const manager = {
    bindSubagentJoin: () => joinBinding([], new Promise(() => {}), {
      release: () => { released++; },
    }),
    onConversationUpdate: () => () => {},
  };
  const promise = joinAction(
    deps(manager),
    { action: "join", subagentIds: [conversationId] },
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
    bindSubagentJoin: (_ids: any, owner: any, toolCallId: any) => {
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
  }, { action: "join", subagentIds: [conversationId] }, undefined, undefined, "join-call-1");
  assert.equal(suspended, conversationId);
  assert.deepEqual(boundOwner, { conversationId, runId });
  assert.equal(boundToolCallId, "join-call-1");
});

test("nested join records one binding for valid siblings and returns invalid targets in place", async () => {
  const childSubagentId = "quiet-otter" as any;
  const childRunId = "assemble-abruptly" as any;
  const unknownSubagentId = "gentle-fox" as any;
  let boundIds: any[] = [];
  const manager = {
    validateSubagentJoin: (target: any) => {
      if (target === unknownSubagentId) throw new Error(`Unknown subagent: ${target}.`);
    },
    bindSubagentJoin: (ids: any[]) => {
      boundIds = ids;
      return {
        ...joinBinding([{ conversationId: childSubagentId, runId: childRunId, status: { kind: "done", outcome: "completed", completedAt: 2 } }]),
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
    subagentIds: [
      { subagentId: "not-an-id", error: "invalid subagentId format" },
      childSubagentId,
      unknownSubagentId,
    ],
  }, undefined, undefined);

  assert.deepEqual(boundIds, [childSubagentId]);
  assert.deepEqual(json(result).results, [
    { ok: false, subagentId: "not-an-id", error: "invalid subagentId format" },
    { ok: true, data: { subagentId: childSubagentId, status: "completed" } },
    { ok: false, subagentId: unknownSubagentId, error: `Unknown subagent: ${unknownSubagentId}.` },
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
    bindSubagentJoin: () => binding,
    onConversationUpdate: () => () => {},
  };
  const pending = joinAction(
    deps(manager),
    { action: "join", subagentIds: [conversationId] },
    undefined,
    undefined,
  );
  resolve();
  assert.deepEqual(json(await pending).results, [{
    ok: true,
    data: { subagentId: conversationId, status: "aborted", error: "Run cancelled." },
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
    bindSubagentJoin: () => joinBinding([{ conversationId, runId, status: snapshots.get(runId).status }]),
    onConversationUpdate: () => () => {},
    runSnapshot: (id: any) => snapshots.get(id),
    listConversations: () => [],
    conversationDisplay: (id: any) => ({ conversationId: id, label: id }),
    unjoinedDirectChildren: (id: any) => id === childRunId
      ? [{ runId: backgroundRunId, conversationId: "background-c" }]
      : [],
  };

  const result = await joinAction(deps(manager), { action: "join", subagentIds: [conversationId] }, undefined, undefined);
  const child = (result.details as any).runs[0].joins[0].targets[0];
  assert.equal(child.joins[0].targets[0].subagentId, "leaf-c");
  assert.equal(child.background[0].entries[0].detachedAtFinal, true);
  assert.doesNotMatch(JSON.stringify(result.details), new RegExp([childRunId, leafRunId, backgroundRunId].join("|")));
  assert.equal("output" in child, false);
});

test("join isolates malformed and unknown targets from valid siblings", async () => {
  const unknownSubagentId = "quiet-otter" as any;
  const malformed = { subagentId: "not-an-id", error: "join received invalid subagentId format 'not-an-id'." };
  const entries = [{ conversationId, runId, status: { kind: "done", outcome: "completed", completedAt: 2, output: "done" } }];
  let subscribed = false;
  const manager = {
    validateSubagentJoin: (target: any) => {
      if (target === unknownSubagentId) throw new Error(`Unknown subagent: ${target}.`);
    },
    bindSubagentJoin: (ids: any[]) => {
      assert.deepEqual(ids, [conversationId]);
      return joinBinding(entries);
    },
    onConversationUpdate: () => {
      subscribed = true;
      return () => {};
    },
  };

  const result = await joinAction(
    deps(manager),
    { action: "join", subagentIds: [conversationId, malformed, unknownSubagentId] },
    undefined,
    undefined,
  );

  assert.equal(result.isError, false);
  assert.equal(subscribed, true);
  assert.deepEqual(json(result).results, [
    { ok: true, data: { subagentId: conversationId, status: "completed", output: "done" } },
    { ok: false, subagentId: malformed.subagentId, error: malformed.error },
    { ok: false, subagentId: unknownSubagentId, error: `Unknown subagent: ${unknownSubagentId}.` },
  ]);
});

test("join returns item errors without binding when no target resolves", async () => {
  let subscribed = false;
  const manager = {
    validateSubagentJoin: () => { throw new Error("Unknown subagent: quiet-otter."); },
    bindSubagentJoin: () => { throw new Error("must not bind"); },
    onConversationUpdate: () => {
      subscribed = true;
      return () => {};
    },
  };
  const result = await joinAction(
    deps(manager),
    { action: "join", subagentIds: [
      { subagentId: "not-an-id", error: "invalid subagentId format" },
      "quiet-otter" as any,
    ] },
    undefined,
    undefined,
  );
  assert.equal(result.isError, false);
  assert.equal(subscribed, false);
  assert.deepEqual(json(result).results, [
    { ok: false, subagentId: "not-an-id", error: "invalid subagentId format" },
    { ok: false, subagentId: "quiet-otter", error: "Unknown subagent: quiet-otter." },
  ]);
});
