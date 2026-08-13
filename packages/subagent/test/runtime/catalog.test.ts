import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, expect } from "vitest";
import { SubagentRuntime } from "../../src/runtime.js";
import { completedGeneration, errorGeneration, Generation } from "../../src/conversation.js";

const knownModel = { provider: "test", id: "known" } as any;
const config = {
  name: "worker",
  description: "",
  systemPrompt: "",
  source: "project",
} as any;
const registry = { agents: new Map([
  ["worker", config],
  ["bad-definition", { ...config, name: "bad-definition", model: "missing" }],
]) } as any;
const ctx = {
  cwd: "/tmp",
  model: knownModel,
  modelRegistry: { getAll: () => [knownModel] },
} as any;
const session = () => ({
  messages: [],
  subscribe: () => () => {},
  abort() {},
  steer() {},
  getSteeringMessages() { return []; },
  getFollowUpMessages() { return []; },
}) as any;
const executor = async (_ctx: any, agent: any, attempt: any) => {
  const activeSession = attempt.kind === "resume" ? agent.sessionForResume() : session();
  agent.bindSession(attempt, activeSession);
  return completedGeneration(agent, attempt, attempt.prompt);
};
const parent = (manager: SubagentRuntime, reference: any) => ({ caller: manager.generationCaller(reference) });
const caller = (manager: SubagentRuntime, reference: any) => ({ caller: manager.generationCaller(reference) });
const output = (entry: any) =>
  entry.status.kind === "done" ? entry.status.output : undefined;
const joinLatest = (manager: SubagentRuntime, subagentId: any, owner?: any) => {
  const binding = manager.bindSubagentJoin([subagentId], owner);
  binding.markCollected("model");
  binding.release();
};

test("spawn records stable conversation ownership and exact generation provenance", async () => {
  const manager = new SubagentRuntime(registry, 2, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;

  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, owner));
  await childStart.completion;
  const child = childStart.starts[0] as any;

  expect(manager.conversation(child.conversationId)).toMatchObject({
    parentConversationId: owner.conversationId,
    spawnedInGeneration: owner.generation,
    generations: [{ startedInParentGeneration: owner.generation }],
  });
});

test("resume preserves conversation ownership and records exact generation provenance", async () => {
  const manager = new SubagentRuntime(registry, 2, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, owner));
  await childStart.completion;
  const child = childStart.starts[0] as any;

  const ownerCaller = manager.generationCaller(owner);
  joinLatest(manager, child.conversationId, ownerCaller);
  const resumed = manager.startTasks(ctx, [{ kind: "resume", subagentId: child.conversationId, prompt: "again" }] as any, { caller: ownerCaller });
  await resumed.completion;

  expect(manager.conversation(child.conversationId)).toMatchObject({
    parentConversationId: owner.conversationId,
    spawnedInGeneration: owner.generation,
    generations: [
      { generation: 1, startedInParentGeneration: owner.generation },
      { generation: 2, startedInParentGeneration: owner.generation },
    ],
  });
});

test("generation initiator follows each start or resume rather than conversation origin", async () => {
  const manager = new SubagentRuntime(registry, 1, executor);
  const initial = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "user start", label: "shared" }] as any, { initiatedBy: "user" });
  await initial.completion;
  const started = initial.starts[0] as any;
  expect(manager.projectSubagent(started.conversationId)).toMatchObject({ generation: 1, initiatedBy: "user" });
  expect(manager.isModelSubscribed(started)).toBe(false);

  joinLatest(manager, started.conversationId);
  expect(manager.projectSubagent(started.conversationId)).toMatchObject({ collected: true, actionHints: expect.not.arrayContaining(["resume"]) });
  expect(manager.startTasks(ctx, [{ kind: "resume", subagentId: started.conversationId, prompt: "too early" }] as any).starts[0])
    .toMatchObject({ ok: false });
  expect(manager.collectSubagentForUser(started.conversationId)).toEqual({
    conversationId: started.conversationId,
    generation: 1,
    collected: true,
  });
  const modelResume = manager.startTasks(ctx, [{ kind: "resume", subagentId: started.conversationId, prompt: "model follow-up" }] as any);
  await modelResume.completion;
  expect(manager.projectSubagent(started.conversationId)).toMatchObject({ generation: 2, initiatedBy: "model" });
  expect(manager.isModelSubscribed({ conversationId: started.conversationId, generation: 2 })).toBe(true);

  joinLatest(manager, started.conversationId);
  const userResume = manager.startTasks(ctx, [{ kind: "resume", subagentId: started.conversationId, prompt: "user follow-up" }] as any, { initiatedBy: "user" });
  await userResume.completion;
  expect(manager.conversation(started.conversationId).generations.map(generation => generation.initiatedBy)).toEqual(["user", "model", "user"]);
});

test("user-initiated terminal generations offer model resume with only the user receipt", async () => {
  const manager = new SubagentRuntime(registry, 1, executor);
  const initial = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "user start", label: "shared" }], { initiatedBy: "user" });
  await initial.completion;
  const started = initial.starts[0] as any;

  expect(manager.collectSubagentForUser(started.conversationId)).toEqual({
    conversationId: started.conversationId,
    generation: started.generation,
    collected: true,
  });
  expect(manager.generationSnapshot(started).receipts).toEqual({ user: true, model: false });
  expect(manager.projectSubagent(started.conversationId)).toMatchObject({
    collected: false,
    actionHints: expect.arrayContaining(["resume"]),
  });

  const modelResume = manager.startTasks(ctx, [{ kind: "resume", subagentId: started.conversationId, prompt: "model follow-up" }]);
  expect(modelResume.starts[0]).toMatchObject({ ok: true, conversationId: started.conversationId, generation: 2 });
  await modelResume.completion;
  expect(manager.conversation(started.conversationId).generations[0].receipts).toEqual({ user: true, model: false });
});

test("generation lineage finds resumed children and remains readable for historical owners", async () => {
  const manager = new SubagentRuntime(registry, 2, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const ownerCaller = manager.generationCaller(owner);

  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any, { caller: ownerCaller });
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const childJoin = manager.bindSubagentJoin([child.conversationId], ownerCaller);
  await childJoin.completion;
  childJoin.markCollected("model");
  childJoin.release();

  const childResume = manager.startTasks(ctx, [{ kind: "resume", subagentId: child.conversationId, prompt: "again" }] as any, { caller: ownerCaller });
  await childResume.completion;
  const resumedChild = childResume.starts[0] as any;

  expect(manager.directChildGenerations(owner)).toEqual([child, resumedChild].map(({ conversationId, generation }) => ({ conversationId, generation })));
  expect(manager.uncollectedDirectChildGenerations(owner)).toEqual([{ conversationId: child.conversationId, generation: 2 }]);

  joinLatest(manager, owner.conversationId);
  const ownerResume = manager.startTasks(ctx, [{ kind: "resume", subagentId: owner.conversationId, prompt: "owner again" }] as any);
  await ownerResume.completion;
  expect(manager.uncollectedDirectChildGenerations(owner)).toEqual([{ conversationId: child.conversationId, generation: 2 }]);
});

test("conversation queries return direct children only", async () => {
  const manager = new SubagentRuntime(registry, 3, executor);
  const rootStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "root", label: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, root));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "grand", label: "grand" }] as any,
    caller(manager, child));
  await grandStart.completion;

  const grand = grandStart.starts[0] as any;
  expect(manager.queryConversations().map(item => item.conversationId)).toEqual([root.conversationId]);
  expect(manager.queryConversations(root.conversationId).map(item => item.conversationId)).toEqual([child.conversationId]);
  expect(manager.queryConversations(child.conversationId).map(item => item.conversationId)).toEqual([grand.conversationId]);
});

test("conversation authorization survives resume and rejects unrelated conversations", async () => {
  const manager = new SubagentRuntime(registry, 4, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, owner));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const unrelatedStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "unrelated", label: "unrelated" }] as any);
  await unrelatedStart.completion;
  const unrelated = unrelatedStart.starts[0] as any;
  joinLatest(manager, owner.conversationId);
  const resumed = manager.startTasks(ctx, [{ kind: "resume", subagentId: owner.conversationId, prompt: "again" }] as any);
  await resumed.completion;
  const resumedOwner = manager.generationCaller(resumed.starts[0] as any);

  expect(manager.inspectSubagents([child.conversationId], resumedOwner)[0].snapshot.generation).toBe(child.generation);
  expect(() => manager.inspectSubagents([unrelated.conversationId], resumedOwner)).toThrow(
    `Subagent ${unrelated.conversationId} is not a descendant of caller subagent ${owner.conversationId}.`,
  );
});

test("removing a conversation deletes its complete terminal subtree", async () => {
  const manager = new SubagentRuntime(registry, 3, executor);
  const rootStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "root", label: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, root));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "grand", label: "grand" }] as any,
    caller(manager, child));
  await grandStart.completion;
  const grand = grandStart.starts[0] as any;

  await expect(manager.removeConversation(child.conversationId, manager.generationCaller(root))).resolves.toEqual({
    ok: true,
    conversationId: child.conversationId,
    label: "child",
    removedIds: [grand.conversationId, child.conversationId],
  });
  expect(() => manager.conversation(child.conversationId)).toThrow(`Subagent ${child.conversationId} was not found.`);
  expect(() => manager.conversation(grand.conversationId)).toThrow(`Subagent ${grand.conversationId} was not found.`);
  expect(manager.conversation(root.conversationId).conversationId).toBe(root.conversationId);
});

test("removal completes before notifying listeners and isolates listener failures", async () => {
  const manager = new SubagentRuntime(registry, 3, executor);
  const rootStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "root", label: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, root));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "grand", label: "grand" }] as any,
    caller(manager, child));
  await grandStart.completion;
  const grand = grandStart.starts[0] as any;
  const updates: string[] = [];

  manager.onConversationUpdate(() => { throw new Error("listener failed"); });
  manager.onConversationUpdate((conversation, kind) => {
    expect(manager.listConversations()).toEqual([]);
    updates.push(`${conversation.conversationId}:${kind}`);
  });

  await expect(manager.removeConversation(root.conversationId)).resolves.toEqual({
    ok: true,
    conversationId: root.conversationId,
    label: "root",
    removedIds: [grand.conversationId, child.conversationId, root.conversationId],
  });
  expect(updates).toEqual([
    `${grand.conversationId}:removed`,
    `${child.conversationId}:removed`,
    `${root.conversationId}:removed`,
  ]);
  for (const identity of [root, child, grand]) {
    expect(() => manager.conversation(identity.conversationId)).toThrow(`Subagent ${identity.conversationId} was not found.`);
    expect(() => manager.generationSnapshot(identity)).toThrow(`Subagent ${identity.conversationId} was not found.`);
  }
});

test("removal rejects an entire subtree when a descendant is active", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    if (attempt.prompt === "child") await gate;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const rootStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "root", label: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, root));
  const child = childStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const result = await manager.removeConversation(root.conversationId);
  expect(result).toMatchObject({ ok: false, conversationId: root.conversationId });
  expect(result.ok ? "" : result.error).toContain(child.conversationId);
  expect(result.ok ? "" : result.error).not.toContain("generation");
  expect(manager.conversation(root.conversationId).conversationId).toBe(root.conversationId);
  expect(manager.conversation(child.conversationId).conversationId).toBe(child.conversationId);

  release();
  await childStart.completion;
});

test("overlapping removal targets attribute each removed id to the shallowest target", async () => {
  const manager = new SubagentRuntime(registry, 2, executor);
  const rootStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "root", label: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, root));
  await childStart.completion;
  const child = childStart.starts[0] as any;

  const outcomes = await manager.removeConversations([root.conversationId, child.conversationId]);
  expect(outcomes).toEqual([
    { ok: true, conversationId: root.conversationId, label: "root", removedIds: [child.conversationId, root.conversationId] },
    { ok: true, conversationId: child.conversationId, label: "child", removedIds: [] },
  ]);
  const removedIds = outcomes.flatMap(outcome => outcome.ok ? outcome.removedIds : []);
  expect(new Set(removedIds)).toEqual(new Set([root.conversationId, child.conversationId]));
  expect(removedIds).toHaveLength(new Set(removedIds).size);
});

test("removal attribution holds when an unrelated target interleaves descendant and ancestor", async () => {
  const manager = new SubagentRuntime(registry, 3, executor);
  const rootStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "root", label: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, root));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const unrelatedStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "unrelated", label: "unrelated" }] as any);
  await unrelatedStart.completion;
  const unrelated = unrelatedStart.starts[0] as any;

  const outcomes = await manager.removeConversations([
    child.conversationId,
    unrelated.conversationId,
    root.conversationId,
  ]);
  expect(outcomes).toEqual([
    { ok: true, conversationId: child.conversationId, label: "child", removedIds: [] },
    { ok: true, conversationId: unrelated.conversationId, label: "unrelated", removedIds: [unrelated.conversationId] },
    { ok: true, conversationId: root.conversationId, label: "root", removedIds: [child.conversationId, root.conversationId] },
  ]);
  const removedIds = outcomes.flatMap(outcome => outcome.ok ? outcome.removedIds : []);
  expect(removedIds).toHaveLength(new Set(removedIds).size);
});

test("child callers cannot resume or remove conversations outside their subtree", async () => {
  const manager = new SubagentRuntime(registry, 3, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }] as any);
  const unrelatedStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "unrelated", label: "unrelated" }] as any);
  await Promise.all([ownerStart.completion, unrelatedStart.completion]);
  const owner = ownerStart.starts[0] as any;
  const unrelated = unrelatedStart.starts[0] as any;
  const ownerCaller = manager.generationCaller(owner);

  expect(manager.startTasks(ctx, [{ kind: "resume", subagentId: unrelated.conversationId, prompt: "again" }] as any,
    { caller: ownerCaller }).starts[0]).toMatchObject({
      ok: false,
      error: `Subagent ${unrelated.conversationId} is not directly owned by caller subagent ${owner.conversationId}.`,
    });
  await expect(manager.removeConversation(unrelated.conversationId, ownerCaller)).resolves.toMatchObject({
    ok: false,
    conversationId: unrelated.conversationId,
  });
});

test("spawning rejects a generation that does not belong to its caller conversation", async () => {
  const manager = new SubagentRuntime(registry, 1, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }] as any);
  await ownerStart.completion;
  const ownerCaller = manager.generationCaller(ownerStart.starts[0] as any);
  const result = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }] as any, {
    caller: { conversation: ownerCaller.conversation, generation: new Generation(1, "foreign", "model", () => {}) },
  });

  expect(result.starts[0]).toEqual({
    ok: false,
    inputIndex: 0,
    error: "Start caller is no longer active.",
  });
});

test("ordered starts reserve capacity and resumes work at capacity", async () => {
  const manager = new SubagentRuntime(registry, 2, executor, 1);
  const batch = manager.startTasks(ctx, [
    { kind: "spawn", agent: "worker", prompt: "one", label: "one" },
    { kind: "spawn", agent: "worker", prompt: "two", label: "two" },
  ] as any);
  expect(batch.starts.map(start => start.ok)).toEqual([true, false]);
  expect((batch.starts[1] as any).error).toContain("Remove inactive subagents");

  await batch.completion;
  const first = batch.starts[0] as any;
  joinLatest(manager, first.conversationId);
  const resumed = manager.startTasks(ctx, [{
    kind: "resume",
    subagentId: first.conversationId,
    prompt: "again",
  }] as any);
  await resumed.completion;

  expect((resumed.starts[0] as any).conversationId).toBe(first.conversationId);
  expect(first.generation).toBe(1);
  expect((resumed.starts[0] as any).generation).toBe(2);
  expect(manager.conversation(first.conversationId).generations.map(generation => generation.generation)).toEqual([1, 2]);
});

test("resume identifies the queued generation blocking a conversation", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    if (attempt.prompt === "blocker") await gate;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const blocker = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "blocker", label: "blocker" }] as any);
  await new Promise(done => setImmediate(done));
  const queued = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "queued", label: "queued" }] as any);
  const active = queued.starts[0] as any;

  const resumed = manager.startTasks(ctx, [{
    kind: "resume",
    subagentId: active.conversationId,
    prompt: "continue",
  }] as any);

  expect(resumed.starts[0]).toEqual({
    ok: false,
    inputIndex: 0,
    error: `Subagent ${active.conversationId} is queued. Wait for or join it before resuming.`,
  });

  release();
  await Promise.all([blocker.completion, queued.completion]);
});

test("active resume failures remain isolated from resumable siblings", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    if (attempt.prompt === "busy") await gate;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const completed = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "completed", label: "completed" }] as any);
  await completed.completion;
  const resumable = completed.starts[0] as any;
  joinLatest(manager, resumable.conversationId);
  const busyStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "busy", label: "busy" }] as any);
  const busy = busyStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const batch = manager.startTasks(ctx, [
    { kind: "resume", subagentId: busy.conversationId, prompt: "blocked" },
    { kind: "resume", subagentId: resumable.conversationId, prompt: "continue" },
  ] as any);

  expect(batch.starts[0]).toMatchObject({
    ok: false,
    inputIndex: 0,
    error: `Subagent ${busy.conversationId} is running. Join it before resuming, or steer it while it runs.`,
  });
  expect(batch.starts[1]).toMatchObject({ ok: true, inputIndex: 1, conversationId: resumable.conversationId });

  release();
  await Promise.all([busyStart.completion, batch.completion]);
});

test("terminal non-resumable conversations retain the generic resume error", async () => {
  const failing = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    return errorGeneration(agent, attempt, "failed");
  };
  const manager = new SubagentRuntime(registry, 1, failing);
  const start = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "fail", label: "fail" }] as any);
  await start.completion;
  const terminal = start.starts[0] as any;

  const resumed = manager.startTasks(ctx, [{
    kind: "resume",
    subagentId: terminal.conversationId,
    prompt: "continue",
  }] as any);

  expect(resumed.starts[0]).toEqual({
    ok: false,
    inputIndex: 0,
    error: `Subagent ${terminal.conversationId} cannot be resumed.`,
  });
});

test("aborted conversations resume only after abort and execution settle", async () => {
  let releaseAbort!: () => void;
  let releaseExecution!: () => void;
  let releaseResume!: () => void;
  const abortGate = new Promise<void>(done => { releaseAbort = done; });
  const executionGate = new Promise<void>(done => { releaseExecution = done; });
  const resumeGate = new Promise<void>(done => { releaseResume = done; });
  const steers: string[] = [];
  let executions = 0;
  let activeExecutions = 0;
  let maxActiveExecutions = 0;
  const retainedSession = {
    ...session(),
    abort: () => abortGate,
    steer: (message: string) => { steers.push(message); },
  };
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    const execution = executions++;
    activeExecutions++;
    maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
    agent.bindSession(attempt, retainedSession);
    try {
      await (execution === 0 ? executionGate : resumeGate);
      return completedGeneration(agent, attempt, attempt.prompt);
    } finally {
      activeExecutions--;
    }
  };
  const manager = new SubagentRuntime(registry, 2, controlled, 1);
  const start = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "stop", label: "stop" }] as any);
  const aborted = start.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const cancelling = manager.cancelSubagent(aborted.conversationId);
  const settlingError = `Subagent ${aborted.conversationId} is still settling a cancelled execution. Wait for it to finish before resuming.`;

  expect(manager.generationSnapshot(aborted).status).toMatchObject({ kind: "done", outcome: "aborted" });
  expect(manager.conversation(aborted.conversationId)).toMatchObject({ isStopping: true });
  const capacityFailure = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "blocked", label: "blocked" }] as any).starts[0] as any;
  expect(capacityFailure.error).not.toContain(aborted.conversationId);
  await expect(manager.removeConversation(aborted.conversationId)).resolves.toMatchObject({
    ok: false,
    conversationId: aborted.conversationId,
    error: expect.stringContaining("has active subagents"),
  });
  expect(manager.projectSubagent(aborted.conversationId).actionHints).not.toContain("resume");
  expect(manager.startTasks(ctx, [{ kind: "resume", subagentId: aborted.conversationId, prompt: "too-early" }] as any).starts[0])
    .toMatchObject({ ok: false, error: settlingError });

  releaseAbort();
  let cancelled = false;
  void cancelling.then(() => { cancelled = true; });
  await new Promise(done => setImmediate(done));
  expect(cancelled).toBe(false);
  expect(executions).toBe(1);

  releaseExecution();
  await Promise.all([start.completion, cancelling]);
  expect(manager.projectSubagent(aborted.conversationId).actionHints).not.toContain("resume");
  joinLatest(manager, aborted.conversationId);
  expect(manager.projectSubagent(aborted.conversationId).actionHints).toContain("resume");

  const resumed = manager.startTasks(ctx, [{ kind: "resume", subagentId: aborted.conversationId, prompt: "continue" }] as any);
  const resumedGeneration = resumed.starts[0] as any;
  await new Promise(done => setImmediate(done));
  await manager.steerSubagent(resumedGeneration.conversationId, "redirect");
  releaseResume();
  await resumed.completion;

  expect(resumedGeneration).toMatchObject({ ok: true, conversationId: aborted.conversationId });
  expect(output(manager.generationSnapshot(resumedGeneration))).toBe("continue");
  expect(steers).toEqual(["redirect"]);
  expect(maxActiveExecutions).toBe(1);
});

test("spawn validation is ordered, isolated, and does not allocate or consume capacity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-manager-validation-"));
  const prompts: string[] = [];
  const countedExecutor = async (executionCtx: any, agent: any, attempt: any) => {
    prompts.push(attempt.prompt);
    return executor(executionCtx, agent, attempt);
  };
  const manager = new SubagentRuntime(registry, 2, countedExecutor, 2);
  const batch = manager.startTasks({ ...ctx, cwd: root }, [
    { kind: "spawn", agent: "worker", prompt: "inherits parent", label: "inherits parent" },
    { kind: "spawn", agent: "missing", prompt: "unknown agent" },
    { kind: "spawn", agent: "worker", prompt: "malformed model", model: "test//known" },
    { kind: "spawn", agent: "worker", prompt: "unknown model", model: "missing" },
    { kind: "spawn", agent: "worker", prompt: "invalid cwd", cwd: "missing-directory" },
    { kind: "spawn", agent: "bad-definition", prompt: "invalid definition model" },
    { kind: "spawn", agent: "bad-definition", prompt: "override wins", label: "override wins", model: "test/known" },
  ] as any);

  expect(batch.starts.map(start => start.inputIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(batch.starts.map(start => start.ok)).toEqual([true, false, false, false, false, false, true]);
  expect(batch.starts[1]).toMatchObject({ error: "Unknown agent: missing." });
  expect(batch.starts[2]).toMatchObject({ error: expect.stringContaining("Invalid model") });
  expect(batch.starts[3]).toMatchObject({ error: "Unknown model: missing" });
  expect(batch.starts[4]).toMatchObject({ error: expect.stringContaining("Working directory does not exist") });
  expect(batch.starts[5]).toMatchObject({ error: "Unknown model: missing" });
  for (const start of batch.starts.filter(start => !start.ok)) {
    expect(start).not.toHaveProperty("conversationId");
    expect(start).not.toHaveProperty("generation");
  }

  await batch.completion;
  expect(prompts).toEqual(["inherits parent", "override wins"]);
  expect(manager.listConversations()).toHaveLength(2);
});

test("spawn rejects unknown requested skills before allocating conversations", async () => {
  const skillRegistry = { agents: new Map([
    ["invalid-skill", { ...config, name: "invalid-skill", skills: ["definitely-missing-subagent-test-skill"] }],
  ]) } as any;
  const manager = new SubagentRuntime(skillRegistry, 2, executor);
  const batch = manager.startTasks(ctx, [
    { kind: "spawn", agent: "invalid-skill", prompt: "invalid", label: "invalid" },
    { kind: "spawn", agent: "invalid-skill", prompt: "override", label: "override", skills: [] },
  ] as any);

  expect(batch.starts[0]).toEqual({
    ok: false,
    inputIndex: 0,
    error: "Unknown skill: definitely-missing-subagent-test-skill",
  });
  expect(batch.starts[1]).toMatchObject({ ok: true, inputIndex: 1 });
  expect(manager.listConversations()).toHaveLength(1);
  await batch.completion;
});

test("model collection marks the exact latest result and unlocks model-initiated resume", async () => {
  const manager = new SubagentRuntime(registry, 1, executor);
  const initial = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "old", label: "old" }] as any);
  await initial.completion;
  const first = initial.starts[0] as any;

  expect(() => manager.bindSubagentJoin([first.conversationId, "missing-subagent" as any])).toThrow();
  const join = manager.bindSubagentJoin([first.conversationId]);
  await join.completion;
  expect(join.project()[0].status).toMatchObject({ kind: "done", outcome: "completed", output: "old" });
  join.markCollected("user");
  expect(manager.generationSnapshot(first).receipts).toEqual({ user: true, model: false });
  expect(manager.projectSubagent(first.conversationId).collected).toBe(false);
  expect(manager.startTasks(ctx, [{ kind: "resume", subagentId: first.conversationId, prompt: "wrong audience" }] as any).starts[0])
    .toMatchObject({ ok: false });
  join.markCollected("model");
  expect(manager.startTasks(ctx, [{ kind: "resume", subagentId: first.conversationId, prompt: "blocked" }] as any).starts[0]).toMatchObject({ ok: false });
  join.release();
  expect(manager.projectSubagent(first.conversationId).actionHints).toContain("resume");

  const resumed = manager.startTasks(ctx, [{ kind: "resume", subagentId: first.conversationId, prompt: "new" }] as any);
  expect(resumed.starts[0]).toMatchObject({ ok: true, conversationId: first.conversationId });
  await resumed.completion;

  join.markCollected("user");
  expect(manager.conversation(first.conversationId).generations.map(generation => generation.receipts)).toEqual([
    { user: true, model: true },
    { user: false, model: false },
  ]);
});

test("nonblocking user collection is terminal-only, idempotent, and unaffected by model subscription", async () => {
  let finish!: () => void;
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    await new Promise<void>(done => { finish = done; });
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const started = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "user work", label: "user work" }], { initiatedBy: "user" });
  const identity = started.starts[0] as any;
  await new Promise(done => setImmediate(done));

  expect(manager.collectSubagentForUser(identity.conversationId)).toEqual({
    conversationId: identity.conversationId,
    generation: identity.generation,
    collected: false,
  });
  expect(manager.generationSnapshot(identity)).toMatchObject({
    activeCollectionCount: 0,
    receipts: { user: false, model: false },
  });
  await manager.steerSubagent(identity.conversationId, "model subscribed");
  expect(manager.isModelSubscribed(identity)).toBe(true);

  finish();
  await started.completion;
  const modelCollection = manager.bindSubagentJoin([identity.conversationId]);
  await modelCollection.completion;
  modelCollection.markCollected("model");
  modelCollection.release();
  expect(manager.generationSnapshot(identity).receipts).toEqual({ user: false, model: true });
  expect(manager.startTasks(ctx, [{ kind: "resume", subagentId: identity.conversationId, prompt: "blocked" }]).starts[0])
    .toMatchObject({ ok: false });

  const collectionUpdates: string[] = [];
  const unsubscribe = manager.onConversationUpdate((_conversation, kind) => collectionUpdates.push(kind));
  const expected = { conversationId: identity.conversationId, generation: identity.generation, collected: true };
  expect(manager.collectSubagentForUser(identity.conversationId)).toEqual(expected);
  expect(manager.collectSubagentForUser(identity.conversationId)).toEqual(expected);
  unsubscribe();
  expect(collectionUpdates).toEqual(["collection"]);
  expect(manager.generationSnapshot(identity)).toMatchObject({
    activeCollectionCount: 0,
    receipts: { user: true, model: true },
  });
  expect(manager.projectSubagent(identity.conversationId)).toMatchObject({ collected: true, actionHints: expect.arrayContaining(["resume"]) });
});

test("user collection validates root ownership", async () => {
  const manager = new SubagentRuntime(registry, 2, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }]);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }], caller(manager, owner));
  await childStart.completion;
  const child = childStart.starts[0] as any;

  expect(() => manager.collectSubagentForUser(child.conversationId)).toThrow(
    `Subagent ${child.conversationId} is not directly owned by the root agent.`,
  );
  expect(manager.generationSnapshot(child).receipts.user).toBe(false);
});

test("completed removal deletes exact generations, prevents resume, and reclaims capacity", async () => {
  const manager = new SubagentRuntime(registry, 1, executor, 1);
  const initial = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "old",
    label: "old",
  }] as any);
  await initial.completion;
  const first = initial.starts[0] as any;
  joinLatest(manager, first.conversationId);
  const resumed = manager.startTasks(ctx, [{
    kind: "resume",
    subagentId: first.conversationId,
    prompt: "new",
  }] as any);
  await resumed.completion;
  const second = resumed.starts[0] as any;

  await expect(manager.removeConversation(first.conversationId)).resolves.toEqual({
    ok: true,
    conversationId: first.conversationId,
    label: "old",
    removedIds: [first.conversationId],
  });
  expect(manager.listConversations()).toEqual([]);
  expect(() => manager.conversation(first.conversationId)).toThrow(`Subagent ${first.conversationId} was not found.`);
  expect(manager.startTasks(ctx, [{
    kind: "resume",
    subagentId: first.conversationId,
    prompt: "again",
  }] as any).starts[0]).toMatchObject({
    error: `Subagent ${first.conversationId} was not found.`,
  });

  expect(() => manager.inspectSubagents([first.conversationId])).toThrow(`Subagent ${first.conversationId} was not found.`);
  expect(() => manager.bindSubagentJoin([second.conversationId])).toThrow(`Subagent ${second.conversationId} was not found.`);

  const replacement = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "replacement",
    label: "replacement",
  }] as any);
  expect(replacement.starts[0]).toMatchObject({ ok: true });
  await replacement.completion;
});

test("removal publishes once while stale join bindings remain silent", async () => {
  const manager = new SubagentRuntime(registry, 1, executor);
  const start = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "done", label: "done" }] as any);
  await start.completion;
  const identity = start.starts[0] as any;
  const binding = manager.bindSubagentJoin([identity.conversationId]);
  await binding.completion;
  const updates: string[] = [];
  const unsubscribe = manager.onConversationUpdate((agent, kind) => updates.push(`${agent.conversationId}:${kind}`));

  await manager.removeConversation(identity.conversationId);
  binding.markCollected("model");
  binding.release();

  expect(updates).toEqual([`${identity.conversationId}:removed`]);
  unsubscribe();
});

test("removal rejects active conversations without changing their generations", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const slow = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    await gate;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, slow);
  const start = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }] as any);
  const active = start.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await expect(manager.removeConversation(active.conversationId)).resolves.toEqual({
    ok: false,
    conversationId: active.conversationId,
    error: `Subagent subtree ${active.conversationId} has active subagents: ${active.conversationId}. Cancel them before removal.`,
  });
  expect(manager.conversation(active.conversationId).generations[0].status.kind).toBe("running");
  expect(manager.inspectSubagents([active.conversationId])[0].snapshot.generation).toBe(active.generation);

  release();
  await start.completion;
});

test("batch removal isolates terminal, active, and unknown conversations", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    if (attempt.prompt === "active") await gate;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const terminalStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "terminal", label: "terminal" }] as any);
  await terminalStart.completion;
  const terminal = terminalStart.starts[0] as any;
  const activeStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "active", label: "active" }] as any);
  const active = activeStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await expect(manager.removeConversations([terminal.conversationId, active.conversationId, "amber-acorn"])).resolves.toEqual([
    { ok: true, conversationId: terminal.conversationId, label: "terminal", removedIds: [terminal.conversationId] },
    {
      ok: false,
      conversationId: active.conversationId,
      error: `Subagent subtree ${active.conversationId} has active subagents: ${active.conversationId}. Cancel them before removal.`,
    },
    { ok: false, conversationId: "amber-acorn", error: "Subagent amber-acorn was not found." },
  ]);
  expect(() => manager.generationSnapshot(terminal)).toThrow(`Subagent ${terminal.conversationId} was not found.`);
  expect(manager.inspectSubagents([active.conversationId])[0].snapshot.status.kind).toBe("running");

  release();
  await activeStart.completion;
});

test("cancellation waits for in-flight steering and retains its discarded receipt", async () => {
  let releaseSteer!: () => void;
  let releaseGeneration!: () => void;
  let steerQueued!: () => void;
  const steerGate = new Promise<void>(done => { releaseSteer = done; });
  const generationGate = new Promise<void>(done => { releaseGeneration = done; });
  const queued = new Promise<void>(done => { steerQueued = done; });
  const steering: string[] = [];
  let clears = 0;
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, {
      ...session(),
      async steer(prompt: string) {
        steering.push(prompt);
        steerQueued();
        await steerGate;
      },
      getSteeringMessages: () => steering,
      clearQueue() {
        clears++;
        const removed = steering.splice(0);
        return { steering: removed, followUp: [] };
      },
    });
    await generationGate;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const started = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }] as any);
  const identity = started.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const steer = manager.steerSubagent(identity.conversationId, "redirect");
  await queued;
  const cancelling = manager.cancelSubagent(identity.conversationId);
  releaseSteer();

  await expect(steer).resolves.toMatchObject({ steer: { state: "discarded" } });
  releaseGeneration();
  await expect(cancelling).resolves.toMatchObject({ conversationId: identity.conversationId, generation: identity.generation });
  expect(clears).toBeGreaterThan(0);
  expect(steering).toEqual([]);
  expect(manager.generationSnapshot(identity).steers).toMatchObject([{ id: 1, state: "discarded" }]);
  expect(manager.conversation(identity.conversationId).generations).toHaveLength(1);

  await started.completion;
});

test("wedged cancellation releases scheduler capacity", async () => {
  const never = new Promise<void>(() => {});
  const executed: string[] = [];
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    executed.push(attempt.prompt);
    agent.bindSession(attempt, { ...session(), abort: () => never });
    if (attempt.prompt === "wedged") await never;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled, 2, 5);
  const wedged = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "wedged", label: "wedged" }]);
  const identity = wedged.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await expect(manager.cancelSubagent(identity.conversationId)).resolves.toEqual({
    conversationId: identity.conversationId,
    generation: identity.generation,
  });
  expect(manager.projectSubagent(identity.conversationId)).toMatchObject({ generation: 1, status: "cancelled", collected: false });
  await expect(manager.cancelSubagent(identity.conversationId)).resolves.toEqual({
    conversationId: identity.conversationId,
    generation: identity.generation,
  });
  const collection = manager.bindSubagentJoin([identity.conversationId]);
  await collection.completion;
  collection.markCollected("model");
  collection.release();
  expect(manager.projectSubagent(identity.conversationId).actionHints).not.toContain("resume");

  const replacement = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "replacement", label: "replacement" }]);
  await replacement.completion;
  expect(executed).toEqual(["wedged", "replacement"]);
});

test("root join remains exact when descendants spawn later", async () => {
  const gates = new Map<string, () => void>();
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    await new Promise<void>(done => gates.set(attempt.prompt, done));
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 8, controlled);
  const rootStart = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "root",
  }] as any);
  const root = rootStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const join = manager.bindSubagentJoin([root.conversationId]);

  const childStart = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "child",
  }] as any, parent(manager, root));
  const child = childStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const grandStart = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "grand",
  }] as any, parent(manager, child));
  await new Promise(done => setImmediate(done));

  gates.get("root")!();
  await rootStart.completion;
  let finished = false;
  void join.completion.then(() => { finished = true; });
  await new Promise(done => setImmediate(done));
  expect(finished).toBe(true);
  expect(join.project().map(entry => [entry.generation, entry.conversationId])).toEqual([[root.generation, root.conversationId]]);
  expect(join.project().map(output)).toEqual(["root"]);
  gates.get("grand")!(); gates.get("child")!();
  await Promise.all([grandStart.completion, childStart.completion]);
  join.release();
});

test("removed conversation generations cannot be joined", async () => {
  const manager = new SubagentRuntime(registry, 4, executor);
  const rootStart = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "root",
  }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "child",
  }] as any, parent(manager, root));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "grand",
  }] as any, parent(manager, child));
  await grandStart.completion;
  const grand = grandStart.starts[0] as any;

  await manager.removeConversation(child.conversationId);
  await manager.removeConversation(root.conversationId);
  await manager.removeConversation(grand.conversationId);
  expect(() => manager.bindSubagentJoin([root.conversationId])).toThrow(`Subagent ${root.conversationId} was not found.`);
  expect(() => manager.inspectSubagents([child.conversationId])).toThrow(`Subagent ${child.conversationId} was not found.`);
  expect(() => manager.generationSnapshot(grand)).toThrow(`Subagent ${grand.conversationId} was not found.`);
});

test("exact join does not bind an unrequested descendant", async () => {
  let releaseRoot!: () => void;
  const rootGate = new Promise<void>(done => { releaseRoot = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    if (attempt.prompt === "root") await rootGate;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 4, controlled);
  const rootStart = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "root",
  }] as any);
  const root = rootStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const childStart = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "child",
  }] as any, parent(manager, root));
  const child = childStart.starts[0] as any;
  await childStart.completion;
  const join = manager.bindSubagentJoin([root.conversationId]);
  expect(join.project().map(entry => entry.generation)).toEqual([root.generation]);

  await manager.removeConversation(child.conversationId);
  releaseRoot();
  await rootStart.completion;
  await join.completion;
  expect(join.project().map(entry => entry.generation)).toEqual([root.generation]);
  expect(join.project().map(output)).toEqual(["root"]);
  join.release();
});

test("duplicate concurrent joins each receive the settled result", async () => {
  const manager = new SubagentRuntime(registry, 1, executor);
  const start = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "done", label: "done" }]);
  await start.completion;
  const identity = start.starts[0] as any;

  const binding = manager.bindSubagentJoin([identity.conversationId, identity.conversationId]);
  await binding.completion;
  expect(binding.project()).toHaveLength(2);
  expect(binding.project().map(output)).toEqual(["done", "done"]);
  const finalized = binding.finalizeCollection("model");
  expect(finalized.map(entry => ({ output: output(entry), canonical: entry.canonical }))).toEqual([
    { output: "done", canonical: expect.objectContaining({ generation: 1, collected: true, actionHints: expect.arrayContaining(["resume"]) }) },
    { output: "done", canonical: expect.objectContaining({ generation: 1, collected: true, actionHints: expect.arrayContaining(["resume"]) }) },
  ]);
  binding.release();
  expect(manager.generationSnapshot(identity).activeCollectionCount).toBe(0);
  expect(manager.projectSubagent(identity.conversationId).collected).toBe(true);
});

test("multi-target join reserves every latest execution before publishing active-collection updates", async () => {
  const manager = new SubagentRuntime(registry, 2, executor);
  const starts = manager.startTasks(ctx, [
    { kind: "spawn", agent: "worker", prompt: "first", label: "first" },
    { kind: "spawn", agent: "worker", prompt: "second", label: "second" },
  ] as any);
  await starts.completion;
  const [first, second] = starts.starts as any[];
  joinLatest(manager, first.conversationId);
  joinLatest(manager, second.conversationId);

  let resume: any;
  const unsubscribe = manager.onConversationUpdate((conversation, kind) => {
    if (!resume && kind === "activeCollection" && conversation.conversationId === first.conversationId) {
      resume = manager.startTasks(ctx, [{ kind: "resume", subagentId: second.conversationId, prompt: "raced" }] as any).starts[0];
    }
  });
  const binding = manager.bindSubagentJoin([first.conversationId, second.conversationId]);
  unsubscribe();

  expect(resume).toMatchObject({ ok: false });
  expect(binding.targets).toEqual([
    { conversationId: first.conversationId, generation: first.generation },
    { conversationId: second.conversationId, generation: second.generation },
  ]);

  let receiptsAtPublication: boolean[] | undefined;
  const unsubscribeCollection = manager.onConversationUpdate((_conversation, kind) => {
    if (kind === "collection" && !receiptsAtPublication) {
      receiptsAtPublication = [first, second].map(target => manager.generationSnapshot(target).receipts.user);
    }
  });
  binding.markCollected("user");
  unsubscribeCollection();
  expect(receiptsAtPublication).toEqual([true, true]);
  binding.release();
});

test("nested join reserves targets before publishing its attempt", async () => {
  const manager = new SubagentRuntime(registry, 3, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const ownerCaller = manager.generationCaller(owner);
  const children = manager.startTasks(ctx, [
    { kind: "spawn", agent: "worker", prompt: "first", label: "first" },
    { kind: "spawn", agent: "worker", prompt: "second", label: "second" },
  ] as any, { caller: ownerCaller });
  await children.completion;
  const [first, second] = children.starts as any[];
  joinLatest(manager, first.conversationId, ownerCaller);
  joinLatest(manager, second.conversationId, ownerCaller);

  let resume: any;
  const unsubscribe = manager.onConversationUpdate((conversation, kind) => {
    if (!resume && kind === "nestedJoin" && conversation.conversationId === owner.conversationId) {
      resume = manager.startTasks(ctx, [{ kind: "resume", subagentId: second.conversationId, prompt: "raced" }] as any, { caller: ownerCaller }).starts[0];
    }
  });
  const binding = manager.bindSubagentJoin([first.conversationId, second.conversationId], ownerCaller);
  unsubscribe();

  expect(resume).toMatchObject({ ok: false });
  expect(binding.targets).toEqual([
    { conversationId: first.conversationId, generation: first.generation },
    { conversationId: second.conversationId, generation: second.generation },
  ]);
  binding.release();
});

test("resume remains blocked until every accepted join releases", async () => {
  const manager = new SubagentRuntime(registry, 1, executor);
  const firstStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "old", label: "old" }] as any);
  await firstStart.completion;
  const first = firstStart.starts[0] as any;
  const firstJoin = manager.bindSubagentJoin([first.conversationId]);
  const secondJoin = manager.bindSubagentJoin([first.conversationId]);
  await Promise.all([firstJoin.completion, secondJoin.completion]);
  firstJoin.markCollected("model");

  expect(manager.projectSubagent(first.conversationId).actionHints).not.toContain("resume");
  expect(manager.startTasks(ctx, [{ kind: "resume", subagentId: first.conversationId, prompt: "new" }] as any).starts[0])
    .toMatchObject({ ok: false });
  firstJoin.release();
  expect(manager.projectSubagent(first.conversationId).actionHints).not.toContain("resume");
  secondJoin.release();
  expect(manager.projectSubagent(first.conversationId).actionHints).toContain("resume");
  expect(manager.startTasks(ctx, [{ kind: "resume", subagentId: first.conversationId, prompt: "new" }] as any).starts[0])
    .toMatchObject({ ok: true });
});

test("spawn execution is independent of caller cancellation", async () => {
  const manager = new SubagentRuntime(registry, 1, executor);
  const controller = new AbortController();
  const batch = manager.startTasks(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "ok",
  }] as any);
  controller.abort();
  await batch.completion;
  const started = batch.starts[0] as any;
  expect(manager.conversation(started.conversationId).generations[0].status).toMatchObject({
    kind: "done",
    outcome: "completed",
  });
});

test("steering targets an exact running generation without creating history", async () => {
  let finish!: () => void;
  const prompts: string[] = [];
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, {
      ...session(),
      steer(prompt: string) { prompts.push(prompt); },
    });
    await new Promise<void>(done => { finish = done; });
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const batch = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }]);
  const started = batch.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await expect(manager.steerSubagent(started.conversationId, "focus on tests")).resolves.toMatchObject({
    conversationId: started.conversationId,
    generation: started.generation,
    steer: { id: 1, state: "queued", acceptedAt: expect.any(Number) },
  });
  await expect(manager.steerSubagent(started.conversationId, "focus on docs")).resolves.toMatchObject({
    conversationId: started.conversationId,
    generation: started.generation,
    steer: { id: 2, state: "queued", acceptedAt: expect.any(Number) },
  });
  expect(prompts).toEqual(["focus on tests", "focus on docs"]);
  expect(manager.conversation(started.conversationId).generations).toHaveLength(1);

  finish();
  await batch.completion;
  await expect(manager.steerSubagent(started.conversationId, "too late")).rejects.toThrow(
    `Subagent ${started.conversationId} is completed and cannot be steered.`,
  );
});

test("only model steering subscribes user-started work to completion delivery", async () => {
  let finish!: () => void;
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    await new Promise<void>(done => { finish = done; });
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const batch = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }], { initiatedBy: "user" });
  const started = batch.starts[0] as any;
  await new Promise(done => setImmediate(done));

  expect(manager.isModelSubscribed(started)).toBe(false);
  await manager.steerSubagent(started.conversationId, "user note", undefined, "user");
  expect(manager.isModelSubscribed(started)).toBe(false);
  manager.inspectSubagents([started.conversationId]);
  expect(manager.isModelSubscribed(started)).toBe(false);
  await manager.steerSubagent(started.conversationId, "model direction");
  expect(manager.isModelSubscribed(started)).toBe(true);

  finish();
  await batch.completion;
});

test("terminal action errors use only public lifecycle statuses", async () => {
  const outcomes = [
    ["completed", "completed"],
    ["error", "failed"],
    ["aborted", "cancelled"],
    ["interrupted", "failed"],
    ["skipped", "failed"],
  ] as const;
  const executor = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, session());
    return agent.settle(attempt, attempt.prompt, { error: "internal detail" });
  };
  const manager = new SubagentRuntime(registry, 1, executor);

  for (const [outcome, publicStatus] of outcomes) {
    const batch = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: outcome, label: outcome }]);
    const started = batch.starts[0] as any;
    await batch.completion;
    await expect(manager.steerSubagent(started.conversationId, "too late")).rejects.toThrow(
      `Subagent ${started.conversationId} is ${publicStatus} and cannot be steered.`,
    );
    if (publicStatus === "cancelled") {
      await expect(manager.cancelSubagent(started.conversationId)).resolves.toEqual({
        conversationId: started.conversationId,
        generation: started.generation,
      });
    } else {
      await expect(manager.cancelSubagent(started.conversationId)).rejects.toThrow(
        `Subagent ${started.conversationId} is ${publicStatus} and cannot be cancelled.`,
      );
    }
  }
});

test("cancellation is idempotent and retains its conversation and exact outcome", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let abortCalls = 0;
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    const activeSession = { ...session(), abort: () => { abortCalls++; return gate; } };
    agent.bindSession(attempt, activeSession);
    activeSession.messages.push({ role: "assistant", content: [{ type: "text", text: "partial answer" }] });
    await gate;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const batch = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }]);
  const started = batch.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const cancelling = manager.cancelSubagent(started.conversationId);
  expect(manager.inspectSubagents([started.conversationId])[0].snapshot.status).toMatchObject({
    kind: "done",
    outcome: "aborted",
    error: "Generation cancelled.",
  });
  await expect(manager.steerSubagent(started.conversationId, "too late")).rejects.toThrow(
    `Subagent ${started.conversationId} is cancelled and cannot be steered.`,
  );
  const repeated = manager.cancelSubagent(started.conversationId);
  expect(abortCalls).toBe(1);
  release();
  const expected = {
    conversationId: started.conversationId,
    generation: started.generation,
  };
  await expect(cancelling).resolves.toEqual(expected);
  await expect(repeated).resolves.toEqual(expected);
  expect(manager.listConversations().map(value => value.conversationId)).toContain(started.conversationId);
  await expect(manager.cancelSubagent(started.conversationId)).resolves.toEqual(expected);
  expect(abortCalls).toBe(1);

  const join = manager.bindSubagentJoin([started.conversationId]);
  await join.completion;
  expect(join.project()[0].status).toMatchObject({ kind: "done", outcome: "aborted", output: "partial answer" });
  join.release();
  await batch.completion;
});

test("queued cancellation settles immediately without dispatching the executor", async () => {
  let finishBlocker!: () => void;
  const blockerPending = new Promise<void>(done => { finishBlocker = done; });
  const executed: string[] = [];
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    executed.push(attempt.prompt);
    agent.bindSession(attempt, session());
    if (attempt.prompt === "blocker") await blockerPending;
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const blocker = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "blocker", label: "blocker" }]);
  await new Promise(done => setImmediate(done));
  let cancelling: Promise<any> | undefined;
  manager.onConversationUpdate(agent => {
    const generation = agent.snapshot().currentGeneration;
    if (generation?.prompt === "queued" && generation.status.kind === "queued") cancelling ??= manager.cancelSubagent(agent.conversationId);
  });
  const queued = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "queued", label: "queued" }]);
  const target = queued.starts[0] as any;
  const join = manager.bindSubagentJoin([target.conversationId]);

  expect(cancelling).toBeDefined();
  await expect(cancelling!).resolves.toEqual({
    conversationId: target.conversationId,
    generation: target.generation,
  });
  await expect(queued.completion).resolves.toEqual(queued.starts);
  await join.completion;
  expect(join.project()[0].status).toMatchObject({ kind: "done", outcome: "aborted" });
  join.markCollected("model");
  join.release();
  expect(executed).toEqual(["blocker"]);
  const resumed = manager.startTasks(ctx, [{ kind: "resume", subagentId: target.conversationId, prompt: "continue" }]);
  expect(resumed.starts[0]).toMatchObject({
    ok: false,
    error: `Subagent ${target.conversationId} cannot be resumed.`,
  });
  await expect(manager.removeConversation(target.conversationId)).resolves.toMatchObject({
    ok: true,
    conversationId: target.conversationId,
    removedIds: [target.conversationId],
  });

  finishBlocker();
  await blocker.completion;
  expect(executed).toEqual(["blocker"]);
});

test("steering rejects queued, terminal, and SDK-rejected targets", async () => {
  let finishFirst!: () => void;
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, {
      ...session(),
      steer() { throw new Error("queue rejected"); },
    });
    if (attempt.prompt === "first") await new Promise<void>(done => { finishFirst = done; });
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const first = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "first", label: "first" }]);
  const second = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "second", label: "second" }]);
  const firstGeneration = first.starts[0] as any;
  const secondGeneration = second.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await expect(manager.steerSubagent(secondGeneration.conversationId, "queued")).rejects.toThrow("queued");
  await expect(manager.cancelSubagent(secondGeneration.conversationId)).resolves.toMatchObject({ generation: secondGeneration.generation });
  await expect(manager.steerSubagent(firstGeneration.conversationId, "running")).rejects.toThrow("queue rejected");
  finishFirst();
  await Promise.all([first.completion, second.completion]);
  await expect(manager.steerSubagent(firstGeneration.conversationId, "late")).rejects.toThrow("completed");
});

test("inspection is ordered and leaves observation state unchanged", async () => {
  const manager = new SubagentRuntime(registry, 1, executor);
  const batch = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "done", label: "done" }]);
  await batch.completion;
  const started = batch.starts[0] as any;
  const before = manager.generationSnapshot(started);

  const inspected = manager.inspectSubagents([started.conversationId, started.conversationId]);

  expect(inspected.map(item => item.snapshot.generation)).toEqual([started.generation, started.generation]);
  expect(manager.generationSnapshot(started)).toMatchObject({
    activeCollectionCount: before.activeCollectionCount,
    receipts: before.receipts,
  });
});

test("ancestors may inspect indirect descendants without changing lifecycle state", async () => {
  const manager = new SubagentRuntime(registry, 4, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }] as any);
  const siblingStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "sibling", label: "sibling" }] as any);
  await Promise.all([ownerStart.completion, siblingStart.completion]);
  const owner = ownerStart.starts[0] as any;
  const sibling = siblingStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    caller(manager, owner));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const leafStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "leaf", label: "leaf" }] as any,
    caller(manager, child));
  await leafStart.completion;
  const leaf = leafStart.starts[0] as any;
  const ownerCaller = manager.generationCaller(owner);
  const before = manager.generationSnapshot(leaf);

  expect(manager.inspectSubagents([leaf.conversationId], ownerCaller)[0].snapshot.generation).toBe(leaf.generation);
  expect(manager.inspectSubagents([leaf.conversationId])[0].snapshot.generation).toBe(leaf.generation);
  expect(manager.projectSubagent(leaf.conversationId, ownerCaller).actionHints).toEqual(["inspect"]);
  expect(manager.projectSubagent(leaf.conversationId).actionHints).toEqual(["inspect"]);
  expect(manager.generationSnapshot(leaf)).toMatchObject({
    activeCollectionCount: before.activeCollectionCount,
    receipts: { user: false, model: false },
  });
  expect(() => manager.inspectSubagents([sibling.conversationId], ownerCaller)).toThrow(
    `Subagent ${sibling.conversationId} is not a descendant of caller subagent ${owner.conversationId}.`,
  );
});

test("nested callers may inspect, steer, and cancel direct children only", async () => {
  const releases = new Map<string, () => void>();
  const messages: string[] = [];
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(attempt, { ...session(), steer(prompt: string) { messages.push(prompt); } });
    await new Promise<void>(done => releases.set(attempt.prompt, done));
    return completedGeneration(agent, attempt, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const ownerBatch = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }]);
  const owner = ownerBatch.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const childBatch = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }], parent(manager, owner));
  const child = childBatch.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const caller = manager.generationCaller(owner);

  expect(manager.inspectSubagents([child.conversationId], caller)[0].snapshot.generation).toBe(child.generation);
  await expect(manager.steerSubagent(child.conversationId, "redirect", caller)).resolves.toMatchObject({ generation: child.generation });
  expect(messages).toEqual(["redirect"]);
  expect(() => manager.inspectSubagents([owner.conversationId], caller)).toThrow("not a descendant");
  await expect(manager.steerSubagent(owner.conversationId, "self", caller)).rejects.toThrow("not directly owned");
  await expect(manager.cancelSubagent(owner.conversationId, caller)).rejects.toThrow("not directly owned");
  const cancelling = manager.cancelSubagent(child.conversationId, caller);
  releases.get("child")!();
  await expect(cancelling).resolves.toMatchObject({ generation: child.generation });

  releases.get("owner")!();
  await Promise.all([childBatch.completion, ownerBatch.completion]);
});

test("only a subagent's direct owner may join it by stable ID", async () => {
  const manager = new SubagentRuntime(registry, 4, executor);
  const rootStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "root", label: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }] as any,
    parent(manager, root));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const leafStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "leaf", label: "leaf" }] as any,
    parent(manager, child));
  await leafStart.completion;
  const leaf = leafStart.starts[0] as any;

  const rootCaller = manager.generationCaller(root);
  const childJoin = manager.bindSubagentJoin([child.conversationId], rootCaller);
  childJoin.release();
  expect(() => manager.bindSubagentJoin([leaf.conversationId], rootCaller)).toThrow("not directly owned");
  expect(() => manager.bindSubagentJoin([child.conversationId])).toThrow("not directly owned");

  const leafJoin = manager.bindSubagentJoin([leaf.conversationId], manager.generationCaller(child));
  leafJoin.markCollected("model");
  leafJoin.release();
  const unauthorizedResume = manager.startTasks(ctx, [{ kind: "resume", subagentId: leaf.conversationId, prompt: "again" }],
    parent(manager, root));
  expect(unauthorizedResume.starts[0]).toMatchObject({ ok: false, error: expect.stringContaining("not directly owned") });
});

test("nested joins validate descendants and preserve ordered attempts without target output", async () => {
  const manager = new SubagentRuntime(registry, 4, executor);
  const ownerStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner", label: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const childStart = manager.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "secret", label: "secret" }] as any,
    parent(manager, owner));
  await childStart.completion;
  const child = childStart.starts[0] as any;

  const nested = manager.bindSubagentJoin(
    [child.conversationId, child.conversationId],
    manager.generationCaller(owner),
    "tool-1",
  ) as any;
  await nested.completion;
  nested.markCollected("model");
  nested.release();

  const snapshot = manager.generationSnapshot(owner);
  expect(snapshot.nestedJoins).toHaveLength(1);
  expect(snapshot.nestedJoins?.[0]).toMatchObject({ state: "completed", toolCallId: "tool-1" });
  expect(snapshot.nestedJoins?.[0].targets.map(target => target.generation)).toEqual([child.generation, child.generation]);
  expect(snapshot.nestedJoins?.[0].targets[0]).not.toHaveProperty("output");
  expect(manager.uncollectedDirectChildGenerations(owner)).toEqual([]);

  expect(() => manager.bindSubagentJoin([owner.conversationId], manager.generationCaller(owner)))
    .toThrow("not directly owned");
  expect(manager.generationSnapshot(owner).nestedJoins).toHaveLength(1);
  expect(manager.generationSnapshot(owner).activeCollectionCount).toBe(0);
});
