import { test } from "vitest";
import assert from "node:assert/strict";
import type { ConversationSnapshot } from "../../src/conversation.js";
import { ZERO_USAGE } from "../helpers/fake-agent.js";
import { SubagentNotFoundError } from "../../src/runtime.js";
import { agentsAction, cancelAction, inspectAction, joinAction, listAction, removeAction, resumeAction, spawnAction, steerAction, type ActionDeps, type ActionRuntime } from "../../src/tool.js";

const conversationId = "amber-acorn" as any;
const runId = "adapt-ably" as any;
const snapshot = (status: any = { kind: "running", startedAt: 1 }): ConversationSnapshot => {
  const run: ConversationSnapshot["runs"][number] = {
    runId,
    kind: "spawn",
    prompt: "x",
    createdAt: 1,
    status,
    activity: { phase: "starting", turns: 0, compactions: 0, toolHistory: [] },
    usage: ZERO_USAGE,
    observerCount: 1,
    joined: false,
    steers: [],
  };
  return {
    conversationId,
    label: "test subagent",
    createdAt: 1,
    agent: { name: "helper", description: "", source: "project" },
    requestedConfig: {},
    runs: [run],
    ...(status.kind !== "done" ? { currentRun: run } : {}),
  };
};
const runtimeDefaults: ActionRuntime = {
  queryConversations: () => [],
  conversationDepth: () => 1,
  listConversations: () => [],
  startRun: () => { throw new Error("Unexpected startRun call."); },
  steerSubagent: async () => { throw new Error("Unexpected steerSubagent call."); },
  cancelSubagent: async () => { throw new Error("Unexpected cancelSubagent call."); },
  inspectSubagents: () => [],
  validateSubagentJoin: () => {},
  bindSubagentJoin: () => { throw new Error("Unexpected bindSubagentJoin call."); },
  onConversationUpdate: () => () => {},
  removeConversations: async () => [],
  conversation: () => { throw new Error("Unknown conversation."); },
  conversationDisplay: id => ({ conversationId: id, agentName: "helper", label: "test subagent" }),
  projectSubagent: id => ({
    ok: true,
    subagentId: id as any,
    label: "test subagent",
    agent: "helper",
    status: "running",
    availableActions: ["steer", "cancel", "inspect", "join"],
  }),
  runSnapshot: () => { throw new Error("Unknown run."); },
  unjoinedDirectChildren: () => [],
  scheduler: { suspendAgentSlotDuring: async (_id, operation) => operation() },
};
const deps = (runtime: Partial<ActionRuntime>): ActionDeps => ({
  runtime: { ...runtimeDefaults, ...runtime },
  agentRegistry: { agents: new Map(), summarizeAgent: () => "" } as ActionDeps["agentRegistry"],
});
const json = (result: any) => JSON.parse(result.content[0].text);
const canonical = (id: any = conversationId, status: any = "running", extras: any = {}) => ({
  ok: true,
  subagentId: id,
  label: "test subagent",
  agent: "helper",
  status,
  ...(status === "completed" || status === "failed" || status === "cancelled" ? { joined: false } : {}),
  availableActions: status === "running" ? ["steer", "cancel", "inspect", "join"] : ["inspect", "join", "remove"],
  ...extras,
});
const joinBinding = (
  entries: any[],
  completion: Promise<void> = Promise.resolve(),
  hooks: { markJoined?: () => void; release?: () => void } = {},
) => ({
  runIds: entries.map(entry => entry.runId),
  completion,
  project: () => entries,
  markJoined: hooks.markJoined ?? (() => {}),
  release: hooks.release ?? (() => {}),
});

test("agents returns definitions in the common response envelope", () => {
  const agent = { name: "helper", description: "Helps", source: "user" };
  const result = agentsAction({
    ...deps({}),
    agentRegistry: { agents: new Map([["helper", agent]]) } as any,
  }, { action: "agents" });

  assert.deepEqual(json(result), {
    action: "agents",
    results: [{ ok: true, ...agent }],
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
      received.push(batch);
      const starts = batch.map((task, inputIndex) => task.agent === "helper"
        ? { ok: true as const, inputIndex, conversationId, runId }
        : { ok: false as const, inputIndex, error: "Unknown agent: missing." });
      return { starts, completion: Promise.resolve(starts) };
    },
    listConversations: () => [],
  };
  const result = await spawnAction(deps(manager), { action: "spawn", spawns: tasks }, {} as any);
  assert.deepEqual(received, [tasks]);
  assert.deepEqual(json(result), {
    action: "spawn",
    summary: { requested: 2, succeeded: 1, failed: 1 },
    results: [
      canonical(),
      { ok: false, agent: "missing", label: "missing agent", error: "Unknown agent: missing." },
    ],
  });
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
    spawns: [{ kind: "spawn", agent: "helper", prompt: "new", label: "new" }],
  }, {} as any);
  const resumed = await resumeAction(deps(manager), {
    action: "resume",
    resumes: [{ kind: "resume", subagentId: conversationId, prompt: "continue" }],
  }, {} as any);

  assert.deepEqual(received.map(task => task.kind), ["spawn", "resume"]);
  assert.deepEqual(json(spawned), {
    action: "spawn",
    summary: { requested: 1, succeeded: 1, failed: 0 },
    results: [canonical()],
  });
  assert.deepEqual(json(resumed), {
    action: "resume",
    summary: { requested: 1, succeeded: 1, failed: 0 },
    results: [canonical()],
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

  assert.deepEqual(json(result), {
    action: "resume",
    summary: { requested: 1, succeeded: 0, failed: 1 },
    results: [{ ...canonical(), ok: false, error }],
  });
});

test("spawn returns task parse failures while starting valid siblings", async () => {
  const tasks = [
    { kind: "spawn" as const, agent: "helper", prompt: "first", label: "first" },
    { error: "Spawn task agent must be a non-empty string.", label: "invalid spawn" },
    { kind: "spawn" as const, agent: "missing", prompt: "third", label: "third" },
  ];
  const batches: any[][] = [];
  const manager = {
    startRun: (_ctx: any, received: any[]) => {
      batches.push(received);
      const starts = received.map((task, inputIndex) => task.agent === "helper"
        ? { ok: true as const, inputIndex, conversationId, runId }
        : { ok: false as const, inputIndex, error: "Unknown agent: missing." });
      return { starts, completion: Promise.resolve(starts) };
    },
    listConversations: () => [],
  };

  const result = await spawnAction(deps(manager), { action: "spawn", spawns: tasks }, {} as any);
  assert.deepEqual(batches, [[tasks[0], tasks[2]]]);

  assert.deepEqual(json(result), {
    action: "spawn",
    summary: { requested: 3, succeeded: 1, failed: 2 },
    results: [
      canonical(),
      { ok: false, label: "invalid spawn", error: tasks[1].error },
      { ok: false, agent: "missing", label: "third", error: "Unknown agent: missing." },
    ],
  });
});

test("steer sends multiple messages in input order", async () => {
  const received: any[] = [];
  const manager = {
    steerSubagent: async (target: any, prompt: string) => {
      received.push([target, prompt]);
      return { conversationId, runId: target, steer: { id: received.length, state: "queued" as const, acceptedAt: received.length } };
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
  assert.deepEqual(response.results.map((entry: any) => entry.subagentId), [conversationId, conversationId, conversationId]);
  assert.deepEqual(response.results.map((entry: any) => entry.steer.id), [1, 2, 3]);
  assert.deepEqual((result.details as any).view.tasks.map((task: any) => task.kind), ["steer", "steer", "steer"]);
  assert.deepEqual((result.details as any).view.tasks.map((task: any) => task.steer.id), [1, 2, 3]);
});

test("steer isolates failures from sibling messages", async () => {
  const secondSubagentId = "quiet-otter" as any;
  const manager = {
    steerSubagent: async (target: any) => {
      if (target === conversationId) throw new Error("Subagent is queued and cannot be steered.");
      return { conversationId: target, runId, steer: { id: 1, state: "queued" as const, acceptedAt: 1 } };
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
    summary: { requested: 2, succeeded: 1, failed: 1 },
    results: [
      { ...canonical(), ok: false, error: "Subagent is queued and cannot be steered." },
      { ...canonical(secondSubagentId), steer: { id: 1, state: "queued", acceptedAt: 1 } },
    ],
  });
});

test("cancel aborts a subagent while retaining its identity", async () => {
  const manager = {
    cancelSubagent: async (target: any) => {
      assert.equal(target, conversationId);
      return { conversationId, runId, status: "aborted" as const };
    },
    listConversations: () => [snapshot({ kind: "done", outcome: "aborted", completedAt: 2, error: "Run cancelled." })],
  };

  const result = await cancelAction(deps(manager), { action: "cancel", subagentIds: [conversationId] });

  assert.deepEqual(json(result), {
    action: "cancel",
    summary: { requested: 1, succeeded: 1, failed: 0 },
    results: [canonical()],
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
      return { conversationId: target, runId, status: "aborted" as const };
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
    summary: { requested: 2, succeeded: 2, failed: 0 },
    results: [canonical(), canonical(secondSubagentId)],
  });
});

test("cancel isolates malformed and runtime failures from valid siblings", async () => {
  const secondSubagentId = "quiet-otter" as any;
  const manager = {
    cancelSubagent: async (target: any) => {
      if (target === conversationId) throw new Error(`Subagent ${target} is completed and cannot be cancelled.`);
      return { conversationId: target, runId, status: "aborted" as const };
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
    summary: { requested: 3, succeeded: 1, failed: 2 },
    results: [
      { ok: false, subagentId: "not-an-id", error: "invalid subagentId format" },
      { ...canonical(), ok: false, error: `Subagent ${conversationId} is completed and cannot be cancelled.` },
      canonical(secondSubagentId),
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
      parentConversationId: "quiet-otter" as any,
      spawnedByRunId: "start-safely" as any,
      requestedOverrides: { model: "requested/model", thinking: "high" as const },
      effectiveConfig: { model: "effective/model", thinking: "medium" as const, cwd: "/work", skills: ["review"], tools: ["read"] },
    }),
    conversationDepth: () => 2,
  };
  const result = inspectAction(deps(manager), { action: "inspect", subagentIds: [conversationId] });
  const response = json(result);
  assert.equal(response.action, "inspect");
  const [entry] = response.results;

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
    conversation: () => ({ ...snapshot(), requestedOverrides: { model: "requested/model", thinking: "high" as const } }),
  };

  const [entry] = json(inspectAction(deps(manager), { action: "inspect", subagentIds: [conversationId] })).results;

  assert.deepEqual(entry.requestedOverrides, { model: "requested/model", thinking: "high" });
  assert.equal("effectiveConfig" in entry, false);
});

test("inspect isolates malformed and unknown targets from valid siblings", () => {
  const unknownSubagentId = "quiet-otter" as any;
  const malformed = { subagentId: "not-an-id", error: "invalid subagentId format" };
  const manager = {
    inspectSubagents: ([target]: any[]) => {
      if (target === unknownSubagentId) throw new SubagentNotFoundError(target);
      return [{ conversationId, snapshot: snapshot().runs[0] }];
    },
    conversationDisplay: (target: any) => {
      if (target === unknownSubagentId) throw new SubagentNotFoundError(target);
      return { conversationId, agentName: "helper" };
    },
    projectSubagent: (target: any) => {
      if (target === unknownSubagentId) throw new SubagentNotFoundError(target);
      return canonical(target);
    },
  };

  const result = inspectAction(deps(manager), {
    action: "inspect",
    subagentIds: [conversationId, malformed, unknownSubagentId],
  });

  const entries = json(result).results;
  assert.equal(entries[0].subagentId, conversationId);
  assert.deepEqual(entries[1], { ok: false, subagentId: "not-an-id", error: "invalid subagentId format" });
  assert.deepEqual(entries[2], {
    ok: false,
    subagentId: unknownSubagentId,
    error: `Subagent ${unknownSubagentId} was not found.`,
  });
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

  assert.doesNotMatch(result.content[0].text, /SECRET/);
  const entry = json(result).results[0];
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

  assert.equal(json(result).results[0].errorSnippet, "Model request failed.");
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

    const [entry] = json(inspectAction(deps(manager), { action: "inspect", subagentIds: [conversationId] })).results;

    assert.equal(entry.errorSnippet.length, 500);
    assert.doesNotMatch(entry.errorSnippet, /\s{2,}/);
    assert.match(entry.errorSnippet, /…$/);
  }
});

test("list filters public statuses and joined results", () => {
  const running: any = snapshot();
  const completed: any = snapshot({ kind: "done", outcome: "completed", completedAt: 2 });
  completed.conversationId = "quiet-otter";
  completed.label = "follow-up review";
  completed.runs[0].joined = true;
  const failed: any = snapshot({ kind: "done", outcome: "error", completedAt: 2, error: "provider failed" });
  failed.conversationId = "closed-canyon";

  const conversations = [running, completed, failed];
  const manager = {
    queryConversations: () => conversations,
    listConversations: () => conversations,
    projectSubagent: (id: any) => {
      const value = conversations.find(item => item.conversationId === id)!;
      const run = value.runs.at(-1);
      const identity = {
        ok: true as const,
        subagentId: id,
        label: value.label,
        agent: value.agent.name,
        availableActions: ["inspect", "join"] as const,
      };
      if (run.status.kind === "running") return { ...identity, status: "running" as const };
      if (run.status.outcome === "completed") {
        return { ...identity, status: "completed" as const, joined: run.joined };
      }
      return {
        ...identity,
        status: "failed" as const,
        joined: run.joined,
        failure: "Subagent failed: provider failed",
      };
    },
  };

  const response = json(listAction(deps(manager), { action: "list", statuses: ["completed"] }));
  assert.equal(response.action, "list");
  assert.deepEqual(response.results.map((item: any) => item.subagentId), ["quiet-otter"]);
  assert.equal(response.results[0].joined, true);
  assert.deepEqual(response.results[0].descendants, []);
  assert.equal("runs" in response.results[0], false);

  const unjoined = json(listAction(deps(manager), { action: "list", joined: false }));
  assert.deepEqual(unjoined.results.map((item: any) => item.subagentId), ["closed-canyon"]);
  assert.equal(unjoined.results[0].failure, "Subagent failed: provider failed");
});

test("remove returns the identity and complete removed subtree", async () => {
  const childSubagentId = "quiet-otter" as any;
  let received: any;
  const summary = [{
    ok: true as const,
    conversationId,
    label: "retained task",
    removedIds: [childSubagentId, conversationId],
  }];
  const result = await removeAction(deps({
    conversationDisplay: id => ({ conversationId: id, agentName: "helper", label: "retained task" }),
    removeConversations: async (ids: any) => {
      received = ids;
      return summary;
    },
  }), { action: "remove", subagentIds: [conversationId] });
  assert.deepEqual(received, [conversationId]);
  assert.deepEqual(json(result), {
    action: "remove",
    summary: { requested: 1, succeeded: 1, failed: 0 },
    results: [{
      ok: true,
      subagentId: conversationId,
      label: "retained task",
      removedIds: [childSubagentId, conversationId],
    }],
  });
});

test("remove preserves ordered malformed and runtime failures without hiding valid siblings", async () => {
  const unknownConversationId = "silent-meadow" as any;
  const malformed = { subagentId: "not-an-id", error: "invalid subagentId format" };
  let received: any;
  const result = await removeAction(deps({
    conversationDisplay: (id: any) => {
      if (id === unknownConversationId) throw new SubagentNotFoundError(id);
      return { conversationId: id, agentName: "helper" };
    },
    removeConversations: async (ids: any) => {
      received = ids;
      return [
        { ok: true as const, conversationId, label: "helper", removedIds: [conversationId] },
        {
          ok: false as const,
          conversationId: unknownConversationId,
          error: `Subagent ${unknownConversationId} was not found.`,
        },
      ];
    },
  }), { action: "remove", subagentIds: [conversationId, malformed, unknownConversationId] });

  assert.deepEqual(received, [conversationId, unknownConversationId]);
  assert.deepEqual(json(result), {
    action: "remove",
    summary: { requested: 3, succeeded: 1, failed: 2 },
    results: [
      {
        ok: true,
        subagentId: conversationId,
        label: "helper",
        removedIds: [conversationId],
      },
      { ok: false, subagentId: "not-an-id", error: "invalid subagentId format" },
      {
        ok: false,
        subagentId: unknownConversationId,
        error: `Subagent ${unknownConversationId} was not found.`,
      },
    ],
  });
});

test("join releases its binding before projecting final resumable actions", async () => {
  let joined = false;
  let released = false;
  const entries = [{
    conversationId,
    runId,
    status: { kind: "done", outcome: "completed", completedAt: 2, output: "done" },
  }];
  const manager = {
    bindSubagentJoin: () => joinBinding(entries, Promise.resolve(), {
      markJoined: () => { joined = true; },
      release: () => { released = true; },
    }),
    onConversationUpdate: () => () => {},
    projectSubagent: () => canonical(conversationId, "completed", {
      joined,
      availableActions: joined && released
        ? ["resume", "inspect", "join", "remove"]
        : ["inspect", "join", "remove"],
    }),
  };

  const result = await joinAction(
    deps(manager),
    { action: "join", subagentIds: [conversationId] },
    undefined,
    undefined,
  );

  assert.deepEqual(json(result).results[0].availableActions, ["resume", "inspect", "join", "remove"]);
});

test("join returns projected child errors as successful tool results", async () => {
  let released = 0;
  let joined = 0;
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
        markJoined: () => { joined++; },
      });
    },
    onConversationUpdate: () => () => {},
    projectSubagent: () => canonical(conversationId, "failed", {
      joined: true,
      availableActions: ["inspect", "join", "remove"],
      failure: "Subagent failed: child failed",
    }),
  };
  const result = await joinAction(
    deps(manager),
    { action: "join", subagentIds: [conversationId] },
    undefined,
    update => updates.push(update),
  );
  assert.deepEqual(json(result), {
    action: "join",
    summary: { requested: 1, succeeded: 1, failed: 0 },
    results: [canonical(conversationId, "failed", {
      joined: true,
      availableActions: ["inspect", "join", "remove"],
      failure: "Subagent failed: child failed",
    })],
  });
  assert.equal(released, 1);
  assert.equal(joined, 1);
  assert.ok(updates.length >= 1);
  assert.deepEqual(JSON.parse(updates[0].content[0].text), {
    action: "join",
    summary: { requested: 1, succeeded: 1, failed: 0 },
    results: [canonical(conversationId, "failed", {
      joined: true,
      availableActions: ["inspect", "join", "remove"],
      failure: "Subagent failed: child failed",
    })],
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

  assert.deepEqual((result.details as any).view.runs[0], {
    subagentId: conversationId,
    status: "completed",
    agent: "helper",
    label: "test subagent",
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
  assert.deepEqual(json(await promise).results.map((entry: any) => entry.subagentId), [conversationId, secondSubagentId]);
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
      if (target === unknownSubagentId) throw new SubagentNotFoundError(target);
    },
    conversationDisplay: (target: any) => {
      if (target === unknownSubagentId) throw new SubagentNotFoundError(target);
      return { conversationId: target, agentName: "helper" };
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
    projectSubagent: (target: any) => {
      if (target !== childSubagentId) throw new SubagentNotFoundError(target);
      return canonical(childSubagentId, "completed", { joined: true });
    },
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
    canonical(childSubagentId, "completed", { joined: true }),
    {
      ok: false,
      subagentId: unknownSubagentId,
      error: `Subagent ${unknownSubagentId} was not found.`,
    },
  ]);
});

test("a bound join marks a cancelled result joined", async () => {
  let resolve!: () => void;
  let joined = 0;
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
    markJoined: () => { joined++; },
  });
  const manager = {
    bindSubagentJoin: () => binding,
    onConversationUpdate: () => () => {},
    projectSubagent: () => canonical(conversationId, "cancelled", {
      joined: true,
      availableActions: ["resume", "inspect", "join", "remove"],
    }),
  };
  const pending = joinAction(
    deps(manager),
    { action: "join", subagentIds: [conversationId] },
    undefined,
    undefined,
  );
  resolve();
  assert.deepEqual(json(await pending).results, [canonical(conversationId, "cancelled", {
    joined: true,
    availableActions: ["resume", "inspect", "join", "remove"],
  })]);
  assert.equal(joined, 1);
});

test("join projection retains terminal descendant joins and final detached backgrounds", async () => {
  const childRunId = "child-boldly" as any;
  const leafRunId = "leaf-quietly" as any;
  const backgroundRunId = "watch-carefully" as any;
  const done = (id: any, nestedJoins: any[] = []) => ({
    runId: id, kind: "spawn", prompt: `prompt ${id}`, createdAt: 1,
    status: { kind: "done", outcome: "completed", completedAt: 2 },
    activity: { turns: 0, compactions: 0, toolHistory: [] }, usage: undefined,
    observerCount: 0, joined: false, nestedJoins,
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
      ? [{ runId: backgroundRunId, conversationId: "background-c" as any }]
      : [],
  };

  const result = await joinAction(deps(manager), { action: "join", subagentIds: [conversationId] }, undefined, undefined);
  const child = (result.details as any).view.runs[0].joins[0].targets[0];
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
      if (target === unknownSubagentId) throw new SubagentNotFoundError(target);
    },
    conversationDisplay: (target: any) => {
      if (target === unknownSubagentId) throw new SubagentNotFoundError(target);
      return { conversationId: target, agentName: "helper" };
    },
    bindSubagentJoin: (ids: any[]) => {
      assert.deepEqual(ids, [conversationId]);
      return joinBinding(entries);
    },
    onConversationUpdate: () => {
      subscribed = true;
      return () => {};
    },
    projectSubagent: (target: any) => {
      if (target !== conversationId) throw new SubagentNotFoundError(target);
      return canonical(conversationId, "completed", { joined: true });
    },
  };

  const result = await joinAction(
    deps(manager),
    { action: "join", subagentIds: [conversationId, malformed, unknownSubagentId] },
    undefined,
    undefined,
  );

  assert.equal(subscribed, true);
  assert.deepEqual(json(result).results, [
    { ...canonical(conversationId, "completed", { joined: true }), output: "done" },
    { ok: false, subagentId: malformed.subagentId, error: malformed.error },
    {
      ok: false,
      subagentId: unknownSubagentId,
      error: `Subagent ${unknownSubagentId} was not found.`,
    },
  ]);
});

test("join returns item errors without binding when no target resolves", async () => {
  let subscribed = false;
  const manager = {
    validateSubagentJoin: () => { throw new SubagentNotFoundError("quiet-otter"); },
    conversationDisplay: () => { throw new SubagentNotFoundError("quiet-otter"); },
    bindSubagentJoin: () => { throw new Error("must not bind"); },
    onConversationUpdate: () => {
      subscribed = true;
      return () => {};
    },
    projectSubagent: (target: any) => { throw new SubagentNotFoundError(target); },
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
  assert.equal(subscribed, false);
  assert.deepEqual(json(result).results, [
    { ok: false, subagentId: "not-an-id", error: "invalid subagentId format" },
    {
      ok: false,
      subagentId: "quiet-otter",
      error: "Subagent quiet-otter was not found.",
    },
  ]);
});
