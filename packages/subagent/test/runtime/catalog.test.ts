import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, expect } from "vitest";
import { SubagentRuntime } from "../../src/runtime.js";
import { completedRun, errorRun } from "../../src/conversation.js";

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
const runner = async (_ctx: any, agent: any, attempt: any) => {
  agent.bindSession(session());
  return completedRun(agent, attempt.runId, attempt.prompt);
};
const parent = (conversationId: any, runId: any) => ({ caller: { conversationId, runId } });
const caller = (conversationId: any, runId: any) => ({ caller: { conversationId, runId } });
const output = (entry: any) =>
  entry.status.kind === "done" ? entry.status.output : undefined;
const joinLatest = (manager: SubagentRuntime, subagentId: any, owner?: any) => {
  const binding = manager.bindSubagentJoin([subagentId], owner);
  binding.acknowledge();
  binding.release();
};

test("spawn records stable conversation ownership and exact run provenance", async () => {
  const manager = new SubagentRuntime(registry, 2, runner);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;

  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    caller(owner.conversationId, owner.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;

  expect(manager.conversation(child.conversationId)).toMatchObject({
    parentConversationId: owner.conversationId,
    spawnedByRunId: owner.runId,
  });
});

test("resume preserves conversation ownership and spawn provenance", async () => {
  const manager = new SubagentRuntime(registry, 2, runner);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    caller(owner.conversationId, owner.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;

  const ownerCaller = { conversationId: owner.conversationId, runId: owner.runId };
  joinLatest(manager, child.conversationId, ownerCaller);
  const resumed = manager.startRun(ctx, [{ kind: "resume", subagentId: child.conversationId, prompt: "again" }] as any, { caller: ownerCaller });
  await resumed.completion;

  expect(manager.conversation(child.conversationId)).toMatchObject({
    parentConversationId: owner.conversationId,
    spawnedByRunId: owner.runId,
  });
});

test("conversation listing defaults to children and expands to descendants", async () => {
  const manager = new SubagentRuntime(registry, 3, runner);
  const rootStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    caller(root.conversationId, root.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "grand" }] as any,
    caller(child.conversationId, child.runId));
  await grandStart.completion;

  const grand = grandStart.starts[0] as any;
  expect(manager.queryConversations().map(item => item.conversationId)).toEqual([root.conversationId]);
  expect(manager.queryConversations(undefined, "descendants").map(item => item.conversationId)).toEqual([
    root.conversationId,
    child.conversationId,
    grand.conversationId,
  ]);
  expect(manager.queryConversations(root.conversationId).map(item => item.conversationId)).toEqual([child.conversationId]);
  expect(manager.queryConversations(root.conversationId, "descendants").map(item => item.conversationId)).toEqual([
    child.conversationId,
    grand.conversationId,
  ]);
});

test("conversation authorization survives resume and rejects unrelated conversations", async () => {
  const manager = new SubagentRuntime(registry, 4, runner);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    caller(owner.conversationId, owner.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const unrelatedStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "unrelated" }] as any);
  await unrelatedStart.completion;
  const unrelated = unrelatedStart.starts[0] as any;
  joinLatest(manager, owner.conversationId);
  const resumed = manager.startRun(ctx, [{ kind: "resume", subagentId: owner.conversationId, prompt: "again" }] as any);
  await resumed.completion;
  const resumedOwner = { conversationId: owner.conversationId, runId: (resumed.starts[0] as any).runId };

  expect(manager.inspectRuns([child.runId], resumedOwner)[0].snapshot.runId).toBe(child.runId);
  expect(() => manager.inspectRuns([unrelated.runId], resumedOwner)).toThrow(
    `Conversation ${unrelated.conversationId} is not a descendant of caller conversation ${owner.conversationId}.`,
  );
});

test("removing a conversation deletes its complete terminal subtree", async () => {
  const manager = new SubagentRuntime(registry, 3, runner);
  const rootStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    caller(root.conversationId, root.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "grand" }] as any,
    caller(child.conversationId, child.runId));
  await grandStart.completion;
  const grand = grandStart.starts[0] as any;

  await expect(manager.removeConversation(child.conversationId)).resolves.toEqual({
    removed: 2,
    conversationIds: [grand.conversationId, child.conversationId],
    errors: [],
  });
  expect(() => manager.conversation(child.conversationId)).toThrow(`Unknown conversation: ${child.conversationId}.`);
  expect(() => manager.conversation(grand.conversationId)).toThrow(`Unknown conversation: ${grand.conversationId}.`);
  expect(manager.conversation(root.conversationId).conversationId).toBe(root.conversationId);
});

test("removal completes before notifying listeners and isolates listener failures", async () => {
  const manager = new SubagentRuntime(registry, 3, runner);
  const rootStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    caller(root.conversationId, root.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "grand" }] as any,
    caller(child.conversationId, child.runId));
  await grandStart.completion;
  const grand = grandStart.starts[0] as any;
  const updates: string[] = [];

  manager.onConversationUpdate(() => { throw new Error("listener failed"); });
  manager.onConversationUpdate((conversation, kind) => {
    expect(manager.listConversations()).toEqual([]);
    updates.push(`${conversation.conversationId}:${kind}`);
  });

  await expect(manager.removeConversation(root.conversationId)).resolves.toEqual({
    removed: 3,
    conversationIds: [grand.conversationId, child.conversationId, root.conversationId],
    errors: [],
  });
  expect(updates).toEqual([
    `${grand.conversationId}:removed`,
    `${child.conversationId}:removed`,
    `${root.conversationId}:removed`,
  ]);
  for (const identity of [root, child, grand]) {
    expect(() => manager.conversation(identity.conversationId)).toThrow(`Unknown conversation: ${identity.conversationId}.`);
    expect(() => manager.runSnapshot(identity.runId)).toThrow(`Unknown run: ${identity.runId}.`);
  }
});

test("removal rejects an entire subtree when a descendant is active", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    if (attempt.prompt === "child") await gate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const rootStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    caller(root.conversationId, root.runId));
  const child = childStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const result = await manager.removeConversation(root.conversationId);
  expect(result).toMatchObject({ removed: 0, conversationIds: [] });
  expect(result.errors[0].error).toContain(child.conversationId);
  expect(result.errors[0].error).not.toContain(child.runId);
  expect(manager.conversation(root.conversationId).conversationId).toBe(root.conversationId);
  expect(manager.conversation(child.conversationId).conversationId).toBe(child.conversationId);

  release();
  await childStart.completion;
});

test("overlapping removal targets collapse into one subtree operation", async () => {
  const manager = new SubagentRuntime(registry, 2, runner);
  const rootStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    caller(root.conversationId, root.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;

  await expect(manager.removeConversations([root.conversationId, child.conversationId])).resolves.toEqual({
    removed: 2,
    conversationIds: [child.conversationId, root.conversationId],
    errors: [],
  });
});

test("child callers cannot resume or remove conversations outside their subtree", async () => {
  const manager = new SubagentRuntime(registry, 3, runner);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  const unrelatedStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "unrelated" }] as any);
  await Promise.all([ownerStart.completion, unrelatedStart.completion]);
  const owner = ownerStart.starts[0] as any;
  const unrelated = unrelatedStart.starts[0] as any;
  const ownerCaller = { conversationId: owner.conversationId, runId: owner.runId };

  expect(manager.startRun(ctx, [{ kind: "resume", subagentId: unrelated.conversationId, prompt: "again" }] as any,
    { caller: ownerCaller }).starts[0]).toMatchObject({
      ok: false,
      error: `Subagent ${unrelated.conversationId} is not directly owned by caller subagent ${owner.conversationId}.`,
    });
  await expect(manager.removeConversation(unrelated.conversationId, ownerCaller)).resolves.toMatchObject({
    removed: 0,
    errors: [{ conversationId: unrelated.conversationId }],
  });
});

test("spawning rejects a caller whose run does not belong to its conversation", () => {
  const manager = new SubagentRuntime(registry, 1, runner);
  const result = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "work" }] as any, {
    caller: { conversationId: "amber-acorn" as any, runId: "adapt-ably" as any },
  });

  expect(result.starts[0]).toEqual({
    ok: false,
    inputIndex: 0,
    error: "Start caller is no longer active.",
  });
});

test("ordered starts reserve capacity and resumes work at capacity", async () => {
  const manager = new SubagentRuntime(registry, 2, runner, 1);
  const batch = manager.startRun(ctx, [
    { kind: "spawn", agent: "worker", prompt: "one" },
    { kind: "spawn", agent: "worker", prompt: "two" },
  ] as any);
  expect(batch.starts.map(start => start.ok)).toEqual([true, false]);
  expect((batch.starts[1] as any).error).toContain("Remove terminal subagents");

  await batch.completion;
  const first = batch.starts[0] as any;
  joinLatest(manager, first.conversationId);
  const resumed = manager.startRun(ctx, [{
    kind: "resume",
    subagentId: first.conversationId,
    prompt: "again",
  }] as any);
  await resumed.completion;

  expect((resumed.starts[0] as any).conversationId).toBe(first.conversationId);
  expect((resumed.starts[0] as any).runId).not.toBe(first.runId);
  expect(manager.conversation(first.conversationId).runs.map(run => run.runId)).toEqual([
    first.runId,
    (resumed.starts[0] as any).runId,
  ]);
});

test("resume identifies the queued run blocking a conversation", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    if (attempt.prompt === "blocker") await gate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const blocker = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "blocker" }] as any);
  await new Promise(done => setImmediate(done));
  const queued = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "queued" }] as any);
  const active = queued.starts[0] as any;

  const resumed = manager.startRun(ctx, [{
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
    agent.bindSession(session());
    if (attempt.prompt === "busy") await gate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const completed = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "completed" }] as any);
  await completed.completion;
  const resumable = completed.starts[0] as any;
  joinLatest(manager, resumable.conversationId);
  const busyStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "busy" }] as any);
  const busy = busyStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const batch = manager.startRun(ctx, [
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
    agent.bindSession(session());
    return errorRun(agent, attempt.runId, "failed");
  };
  const manager = new SubagentRuntime(registry, 1, failing);
  const start = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "fail" }] as any);
  await start.completion;
  const terminal = start.starts[0] as any;

  const resumed = manager.startRun(ctx, [{
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
    agent.bindSession(retainedSession);
    try {
      await (execution === 0 ? executionGate : resumeGate);
      return completedRun(agent, attempt.runId, attempt.prompt);
    } finally {
      activeExecutions--;
    }
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const start = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "stop" }] as any);
  const aborted = start.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const cancelling = manager.cancelRun(aborted.runId);
  const settlingError = `Subagent ${aborted.conversationId} is still settling a cancelled execution. Wait for it to finish before resuming.`;

  expect(manager.runSnapshot(aborted.runId).status).toMatchObject({ kind: "done", outcome: "aborted" });
  expect(manager.conversation(aborted.conversationId).canResume).toBe(false);
  expect(manager.startRun(ctx, [{ kind: "resume", subagentId: aborted.conversationId, prompt: "too-early" }] as any).starts[0])
    .toMatchObject({ ok: false, error: settlingError });

  releaseAbort();
  await cancelling;
  expect(manager.conversation(aborted.conversationId).canResume).toBe(false);
  expect(manager.startRun(ctx, [{ kind: "resume", subagentId: aborted.conversationId, prompt: "still-early" }] as any).starts[0])
    .toMatchObject({ ok: false, error: settlingError });
  expect(executions).toBe(1);

  releaseExecution();
  await start.completion;
  expect(manager.conversation(aborted.conversationId).canResume).toBe(false);
  joinLatest(manager, aborted.conversationId);
  expect(manager.conversation(aborted.conversationId).canResume).toBe(true);

  const resumed = manager.startRun(ctx, [{ kind: "resume", subagentId: aborted.conversationId, prompt: "continue" }] as any);
  const resumedRun = resumed.starts[0] as any;
  await new Promise(done => setImmediate(done));
  await manager.steerRun(resumedRun.runId, "redirect");
  releaseResume();
  await resumed.completion;

  expect(resumedRun).toMatchObject({ ok: true, conversationId: aborted.conversationId });
  expect(output(manager.runSnapshot(resumedRun.runId))).toBe("continue");
  expect(steers).toEqual(["redirect"]);
  expect(maxActiveExecutions).toBe(1);
});

test("spawn validation is ordered, isolated, and does not allocate or consume capacity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-manager-validation-"));
  const prompts: string[] = [];
  const countedRunner = async (runCtx: any, agent: any, attempt: any) => {
    prompts.push(attempt.prompt);
    return runner(runCtx, agent, attempt);
  };
  const manager = new SubagentRuntime(registry, 2, countedRunner, 2);
  const batch = manager.startRun({ ...ctx, cwd: root }, [
    { kind: "spawn", agent: "worker", prompt: "inherits parent" },
    { kind: "spawn", agent: "missing", prompt: "unknown agent" },
    { kind: "spawn", agent: "worker", prompt: "malformed model", model: "test//known" },
    { kind: "spawn", agent: "worker", prompt: "unknown model", model: "missing" },
    { kind: "spawn", agent: "worker", prompt: "invalid cwd", cwd: "missing-directory" },
    { kind: "spawn", agent: "bad-definition", prompt: "invalid definition model" },
    { kind: "spawn", agent: "bad-definition", prompt: "override wins", model: "test/known" },
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
    expect(start).not.toHaveProperty("runId");
  }

  await batch.completion;
  expect(prompts).toEqual(["inherits parent", "override wins"]);
  expect(manager.listConversations()).toHaveLength(2);
});

test("joining acknowledges the latest outcome and unlocks resume", async () => {
  const manager = new SubagentRuntime(registry, 1, runner);
  const initial = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "old" }] as any);
  await initial.completion;
  const first = initial.starts[0] as any;

  expect(() => manager.bindJoin([first.runId, "missing-run" as any])).toThrow();
  const join = manager.bindSubagentJoin([first.conversationId]);
  await join.completion;
  expect(join.project()[0].status).toMatchObject({ kind: "done", outcome: "completed", output: "old" });
  join.acknowledge();
  expect(manager.conversation(first.conversationId).canResume).toBe(false);
  join.release();
  expect(manager.conversation(first.conversationId).canResume).toBe(true);

  const resumed = manager.startRun(ctx, [{ kind: "resume", subagentId: first.conversationId, prompt: "new" }] as any);
  expect(resumed.starts[0]).toMatchObject({ ok: true, conversationId: first.conversationId });
  await resumed.completion;
});

test("completed removal deletes exact runs, prevents resume, and reclaims capacity", async () => {
  const manager = new SubagentRuntime(registry, 1, runner, 1);
  const initial = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "old",
  }] as any);
  await initial.completion;
  const first = initial.starts[0] as any;
  joinLatest(manager, first.conversationId);
  const resumed = manager.startRun(ctx, [{
    kind: "resume",
    subagentId: first.conversationId,
    prompt: "new",
  }] as any);
  await resumed.completion;
  const second = resumed.starts[0] as any;

  await expect(manager.removeConversation(first.conversationId)).resolves.toEqual({
    removed: 1,
    conversationIds: [first.conversationId],
    errors: [],
  });
  expect(manager.listConversations()).toEqual([]);
  expect(() => manager.conversation(first.conversationId)).toThrow("Unknown conversation");
  expect((manager.startRun(ctx, [{
    kind: "resume",
    subagentId: first.conversationId,
    prompt: "again",
  }] as any).starts[0] as any).error).toContain("Unknown subagent");

  expect(() => manager.inspectRuns([first.runId])).toThrow(`Unknown run: ${first.runId}.`);
  expect(() => manager.bindJoin([second.runId])).toThrow(`Unknown run: ${second.runId}.`);

  const replacement = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "replacement",
  }] as any);
  expect(replacement.starts[0]).toMatchObject({ ok: true });
  await replacement.completion;
});

test("removal publishes once while stale join bindings remain silent", async () => {
  const manager = new SubagentRuntime(registry, 1, runner);
  const start = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "done" }] as any);
  await start.completion;
  const identity = start.starts[0] as any;
  const binding = manager.bindJoin([identity.runId]);
  await binding.completion;
  const updates: string[] = [];
  const unsubscribe = manager.onConversationUpdate((agent, kind) => updates.push(`${agent.conversationId}:${kind}`));

  await manager.removeConversation(identity.conversationId);
  binding.acknowledge();
  binding.release();

  expect(updates).toEqual([`${identity.conversationId}:removed`]);
  unsubscribe();
});

test("removal rejects active conversations without changing their runs", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const slow = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    await gate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, slow);
  const start = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "work" }] as any);
  const active = start.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await expect(manager.removeConversation(active.conversationId)).resolves.toEqual({
    removed: 0,
    conversationIds: [],
    errors: [{
      conversationId: active.conversationId,
      error: `Subagent subtree ${active.conversationId} has active subagents: ${active.conversationId}. Cancel them before removal.`,
    }],
  });
  expect(manager.conversation(active.conversationId).runs[0].status.kind).toBe("running");
  expect(manager.inspectRuns([active.runId])[0].snapshot.runId).toBe(active.runId);

  release();
  await start.completion;
});

test("batch removal isolates terminal, active, and unknown conversations", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    if (attempt.prompt === "active") await gate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const terminalStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "terminal" }] as any);
  await terminalStart.completion;
  const terminal = terminalStart.starts[0] as any;
  const activeStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "active" }] as any);
  const active = activeStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await expect(manager.removeConversations([terminal.conversationId, active.conversationId, "amber-acorn"])).resolves.toEqual({
    removed: 1,
    conversationIds: [terminal.conversationId],
    errors: [
      {
        conversationId: active.conversationId,
        error: `Subagent subtree ${active.conversationId} has active subagents: ${active.conversationId}. Cancel them before removal.`,
      },
      { conversationId: "amber-acorn", error: "Unknown subagent: amber-acorn." },
    ],
  });
  expect(() => manager.runSnapshot(terminal.runId)).toThrow(`Unknown run: ${terminal.runId}.`);
  expect(manager.inspectRuns([active.runId])[0].snapshot.status.kind).toBe("running");

  release();
  await activeStart.completion;
});

test("cancellation waits for in-flight steering and retains its discarded receipt", async () => {
  let releaseSteer!: () => void;
  let releaseRun!: () => void;
  let steerQueued!: () => void;
  const steerGate = new Promise<void>(done => { releaseSteer = done; });
  const runGate = new Promise<void>(done => { releaseRun = done; });
  const queued = new Promise<void>(done => { steerQueued = done; });
  const steering: string[] = [];
  let clears = 0;
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession({
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
    await runGate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const started = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "work" }] as any);
  const identity = started.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const steer = manager.steerRun(identity.runId, "redirect");
  await queued;
  const cancelling = manager.cancelRun(identity.runId);
  releaseSteer();

  await expect(steer).resolves.toMatchObject({ steer: { state: "discarded" } });
  await expect(cancelling).resolves.toMatchObject({ conversationId: identity.conversationId, runId: identity.runId, status: "aborted" });
  expect(clears).toBeGreaterThan(0);
  expect(steering).toEqual([]);
  expect(manager.runSnapshot(identity.runId).steers).toMatchObject([{ id: 1, state: "discarded" }]);
  expect(manager.conversation(identity.conversationId).runs).toHaveLength(1);

  releaseRun();
  await started.completion;
});

test("root join remains exact when descendants spawn later", async () => {
  const gates = new Map<string, () => void>();
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    await new Promise<void>(done => gates.set(attempt.prompt, done));
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 8, controlled);
  const rootStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "root",
  }] as any);
  const root = rootStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const join = manager.bindJoin([root.runId]);

  const childStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "child",
  }] as any, parent(root.conversationId, root.runId));
  const child = childStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const grandStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "grand",
  }] as any, parent(child.conversationId, child.runId));
  await new Promise(done => setImmediate(done));

  gates.get("root")!();
  await rootStart.completion;
  let finished = false;
  void join.completion.then(() => { finished = true; });
  await new Promise(done => setImmediate(done));
  expect(finished).toBe(true);
  expect(join.project().map(entry => [entry.runId, entry.conversationId])).toEqual([[root.runId, root.conversationId]]);
  expect(join.project().map(output)).toEqual(["root"]);
  gates.get("grand")!(); gates.get("child")!();
  await Promise.all([grandStart.completion, childStart.completion]);
  join.release();
});

test("removed conversation runs cannot be joined", async () => {
  const manager = new SubagentRuntime(registry, 4, runner);
  const rootStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "root",
  }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "child",
  }] as any, parent(root.conversationId, root.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "grand",
  }] as any, parent(child.conversationId, child.runId));
  await grandStart.completion;
  const grand = grandStart.starts[0] as any;

  await manager.removeConversation(child.conversationId);
  await manager.removeConversation(root.conversationId);
  await manager.removeConversation(grand.conversationId);
  expect(() => manager.bindJoin([root.runId])).toThrow(`Unknown run: ${root.runId}.`);
  expect(() => manager.inspectRuns([child.runId])).toThrow(`Unknown run: ${child.runId}.`);
  expect(() => manager.runSnapshot(grand.runId)).toThrow(`Unknown run: ${grand.runId}.`);
});

test("exact join does not bind an unrequested descendant", async () => {
  let releaseRoot!: () => void;
  const rootGate = new Promise<void>(done => { releaseRoot = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    if (attempt.prompt === "root") await rootGate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 4, controlled);
  const rootStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "root",
  }] as any);
  const root = rootStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const childStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "child",
  }] as any, parent(root.conversationId, root.runId));
  const child = childStart.starts[0] as any;
  await childStart.completion;
  const join = manager.bindJoin([root.runId]);
  expect(join.project().map(entry => entry.runId)).toEqual([root.runId]);

  await manager.removeConversation(child.conversationId);
  releaseRoot();
  await rootStart.completion;
  await join.completion;
  expect(join.project().map(entry => entry.runId)).toEqual([root.runId]);
  expect(join.project().map(output)).toEqual(["root"]);
  join.release();
});

test("multi-target join reserves every latest execution before publishing observer updates", async () => {
  const manager = new SubagentRuntime(registry, 2, runner);
  const starts = manager.startRun(ctx, [
    { kind: "spawn", agent: "worker", prompt: "first" },
    { kind: "spawn", agent: "worker", prompt: "second" },
  ] as any);
  await starts.completion;
  const [first, second] = starts.starts as any[];
  joinLatest(manager, first.conversationId);
  joinLatest(manager, second.conversationId);

  let resume: any;
  const unsubscribe = manager.onConversationUpdate((conversation, kind) => {
    if (!resume && kind === "observer" && conversation.conversationId === first.conversationId) {
      resume = manager.startRun(ctx, [{ kind: "resume", subagentId: second.conversationId, prompt: "raced" }] as any).starts[0];
    }
  });
  const binding = manager.bindSubagentJoin([first.conversationId, second.conversationId]);
  unsubscribe();

  expect(resume).toMatchObject({ ok: false });
  expect(binding.runIds).toEqual([first.runId, second.runId]);
  binding.release();
});

test("nested join reserves targets before publishing its attempt", async () => {
  const manager = new SubagentRuntime(registry, 3, runner);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const ownerCaller = { conversationId: owner.conversationId, runId: owner.runId };
  const children = manager.startRun(ctx, [
    { kind: "spawn", agent: "worker", prompt: "first" },
    { kind: "spawn", agent: "worker", prompt: "second" },
  ] as any, { caller: ownerCaller });
  await children.completion;
  const [first, second] = children.starts as any[];
  joinLatest(manager, first.conversationId, ownerCaller);
  joinLatest(manager, second.conversationId, ownerCaller);

  let resume: any;
  const unsubscribe = manager.onConversationUpdate((conversation, kind) => {
    if (!resume && kind === "nestedJoin" && conversation.conversationId === owner.conversationId) {
      resume = manager.startRun(ctx, [{ kind: "resume", subagentId: second.conversationId, prompt: "raced" }] as any, { caller: ownerCaller }).starts[0];
    }
  });
  const binding = manager.bindSubagentJoin([first.conversationId, second.conversationId], ownerCaller);
  unsubscribe();

  expect(resume).toMatchObject({ ok: false });
  expect(binding.runIds).toEqual([first.runId, second.runId]);
  binding.release();
});

test("resume remains blocked until every accepted join releases", async () => {
  const manager = new SubagentRuntime(registry, 1, runner);
  const firstStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "old" }] as any);
  await firstStart.completion;
  const first = firstStart.starts[0] as any;
  const join = manager.bindSubagentJoin([first.conversationId]);
  await join.completion;
  join.acknowledge();

  expect(manager.startRun(ctx, [{ kind: "resume", subagentId: first.conversationId, prompt: "new" }] as any).starts[0])
    .toMatchObject({ ok: false });
  join.release();
  expect(manager.startRun(ctx, [{ kind: "resume", subagentId: first.conversationId, prompt: "new" }] as any).starts[0])
    .toMatchObject({ ok: true });
});

test("spawn execution is independent of caller cancellation", async () => {
  const manager = new SubagentRuntime(registry, 1, runner);
  const controller = new AbortController();
  const batch = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "ok",
  }] as any);
  controller.abort();
  await batch.completion;
  const started = batch.starts[0] as any;
  expect(manager.conversation(started.conversationId).runs[0].status).toMatchObject({
    kind: "done",
    outcome: "completed",
  });
});

test("steering targets an exact running run without creating history", async () => {
  let finish!: () => void;
  const prompts: string[] = [];
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession({
      ...session(),
      steer(prompt: string) { prompts.push(prompt); },
    });
    await new Promise<void>(done => { finish = done; });
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const batch = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "work" }]);
  const started = batch.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await expect(manager.steerRun(started.runId, "focus on tests")).resolves.toMatchObject({
    conversationId: started.conversationId,
    runId: started.runId,
    steer: { id: 1, state: "queued", acceptedAt: expect.any(Number) },
  });
  await expect(manager.steerSubagent(started.conversationId, "focus on docs")).resolves.toMatchObject({
    conversationId: started.conversationId,
    runId: started.runId,
    steer: { id: 2, state: "queued", acceptedAt: expect.any(Number) },
  });
  expect(prompts).toEqual(["focus on tests", "focus on docs"]);
  expect(manager.conversation(started.conversationId).runs).toHaveLength(1);

  finish();
  await batch.completion;
  await expect(manager.steerSubagent(started.conversationId, "too late")).rejects.toThrow(
    `Subagent ${started.conversationId} is completed and cannot be steered.`,
  );
});

test("cancelling an active run retains its conversation and exact outcome", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession({ ...session(), abort: () => gate });
    await gate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const batch = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "work" }]);
  const started = batch.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const cancelling = manager.cancelRun(started.runId);
  expect(manager.inspectRuns([started.runId])[0].snapshot.status).toMatchObject({
    kind: "done",
    outcome: "aborted",
    error: "Run cancelled.",
  });
  release();
  await expect(cancelling).resolves.toEqual({
    conversationId: started.conversationId,
    runId: started.runId,
    status: "aborted",
  });
  expect(manager.listConversations().map(value => value.conversationId)).toContain(started.conversationId);
  await expect(manager.cancelRun(started.runId)).rejects.toThrow(`Run ${started.runId} is aborted and cannot be cancelled.`);
  await expect(manager.cancelSubagent(started.conversationId)).rejects.toThrow(`Subagent ${started.conversationId} is aborted and cannot be cancelled.`);

  const join = manager.bindJoin([started.runId]);
  await join.completion;
  expect(join.project()[0].status).toMatchObject({ kind: "done", outcome: "aborted" });
  join.release();
  await batch.completion;
});

test("queued cancellation settles immediately without dispatching the executor", async () => {
  let finishBlocker!: () => void;
  const blockerPending = new Promise<void>(done => { finishBlocker = done; });
  const executed: string[] = [];
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    executed.push(attempt.prompt);
    agent.bindSession(session());
    if (attempt.prompt === "blocker") await blockerPending;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const blocker = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "blocker" }]);
  await new Promise(done => setImmediate(done));
  let cancelling: Promise<any> | undefined;
  manager.onConversationUpdate(agent => {
    const run = agent.snapshot().currentRun;
    if (run?.prompt === "queued" && run.status.kind === "queued") cancelling ??= manager.cancelRun(run.runId);
  });
  const queued = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "queued" }]);
  const target = queued.starts[0] as any;
  const join = manager.bindJoin([target.runId]);

  expect(cancelling).toBeDefined();
  await expect(cancelling!).resolves.toEqual({
    conversationId: target.conversationId,
    runId: target.runId,
    status: "aborted",
  });
  await expect(queued.completion).resolves.toEqual(queued.starts);
  await join.completion;
  expect(join.project()[0].status).toMatchObject({ kind: "done", outcome: "aborted" });
  join.acknowledge();
  join.release();
  expect(executed).toEqual(["blocker"]);
  const resumed = manager.startRun(ctx, [{ kind: "resume", subagentId: target.conversationId, prompt: "continue" }]);
  expect(resumed.starts[0]).toMatchObject({
    ok: false,
    error: `Subagent ${target.conversationId} cannot be resumed.`,
  });
  await expect(manager.removeConversation(target.conversationId)).resolves.toMatchObject({
    removed: 1,
    conversationIds: [target.conversationId],
    errors: [],
  });

  finishBlocker();
  await blocker.completion;
  expect(executed).toEqual(["blocker"]);
});

test("steering rejects queued, terminal, and SDK-rejected targets", async () => {
  let finishFirst!: () => void;
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession({
      ...session(),
      steer() { throw new Error("queue rejected"); },
    });
    if (attempt.prompt === "first") await new Promise<void>(done => { finishFirst = done; });
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 1, controlled);
  const first = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "first" }]);
  const second = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "second" }]);
  const firstRun = first.starts[0] as any;
  const secondRun = second.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await expect(manager.steerRun(secondRun.runId, "queued")).rejects.toThrow("queued");
  await expect(manager.cancelRun(secondRun.runId)).resolves.toMatchObject({ runId: secondRun.runId, status: "aborted" });
  await expect(manager.steerRun(firstRun.runId, "running")).rejects.toThrow("queue rejected");
  finishFirst();
  await Promise.all([first.completion, second.completion]);
  await expect(manager.steerRun(firstRun.runId, "late")).rejects.toThrow("completed");
});

test("inspection is ordered and leaves observation state unchanged", async () => {
  const manager = new SubagentRuntime(registry, 1, runner);
  const batch = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "done" }]);
  await batch.completion;
  const started = batch.starts[0] as any;
  const before = manager.runSnapshot(started.runId);

  const inspected = manager.inspectRuns([started.runId, started.runId]);

  expect(inspected.map(item => item.snapshot.runId)).toEqual([started.runId, started.runId]);
  expect(manager.runSnapshot(started.runId)).toMatchObject({
    observerCount: before.observerCount,
    acknowledged: before.acknowledged,
  });
});

test("nested callers may inspect, steer, and cancel descendants only", async () => {
  const releases = new Map<string, () => void>();
  const messages: string[] = [];
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession({ ...session(), steer(prompt: string) { messages.push(prompt); } });
    await new Promise<void>(done => releases.set(attempt.prompt, done));
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const ownerBatch = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }]);
  const owner = ownerBatch.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const childBatch = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }], parent(owner.conversationId, owner.runId));
  const child = childBatch.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const caller = { conversationId: owner.conversationId, runId: owner.runId };

  expect(manager.inspectRuns([child.runId], caller)[0].snapshot.runId).toBe(child.runId);
  await expect(manager.steerRun(child.runId, "redirect", caller)).resolves.toMatchObject({ runId: child.runId });
  expect(messages).toEqual(["redirect"]);
  expect(() => manager.inspectRuns([owner.runId], caller)).toThrow("not a descendant");
  await expect(manager.steerRun(owner.runId, "self", caller)).rejects.toThrow("not a descendant");
  await expect(manager.cancelRun(owner.runId, caller)).rejects.toThrow("not a descendant");
  await expect(manager.cancelRun(child.runId, caller)).resolves.toMatchObject({ runId: child.runId, status: "aborted" });

  releases.get("child")!(); releases.get("owner")!();
  await Promise.all([childBatch.completion, ownerBatch.completion]);
});

test("only a subagent's direct owner may join it by stable ID", async () => {
  const manager = new SubagentRuntime(registry, 4, runner);
  const rootStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    parent(root.conversationId, root.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const leafStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "leaf" }] as any,
    parent(child.conversationId, child.runId));
  await leafStart.completion;
  const leaf = leafStart.starts[0] as any;

  const childJoin = manager.bindSubagentJoin([child.conversationId], { conversationId: root.conversationId, runId: root.runId });
  childJoin.release();
  expect(() => manager.bindSubagentJoin([leaf.conversationId], { conversationId: root.conversationId, runId: root.runId })).toThrow("not directly owned");
  expect(() => manager.bindSubagentJoin([child.conversationId])).toThrow("not directly owned");

  const leafJoin = manager.bindSubagentJoin([leaf.conversationId], { conversationId: child.conversationId, runId: child.runId });
  leafJoin.acknowledge();
  leafJoin.release();
  const unauthorizedResume = manager.startRun(ctx, [{ kind: "resume", subagentId: leaf.conversationId, prompt: "again" }],
    parent(root.conversationId, root.runId));
  expect(unauthorizedResume.starts[0]).toMatchObject({ ok: false, error: expect.stringContaining("not directly owned") });
});

test("nested joins validate descendants and preserve ordered attempts without target output", async () => {
  const manager = new SubagentRuntime(registry, 4, runner);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "secret" }] as any,
    parent(owner.conversationId, owner.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;

  const nested = manager.bindNestedJoin({ conversationId: owner.conversationId, runId: owner.runId },
    [child.runId, child.runId], "tool-1");
  await nested.completion;
  nested.acknowledge();
  nested.release();

  const snapshot = manager.runSnapshot(owner.runId);
  expect(snapshot.nestedJoins).toHaveLength(1);
  expect(snapshot.nestedJoins?.[0]).toMatchObject({ state: "completed", toolCallId: "tool-1" });
  expect(snapshot.nestedJoins?.[0].targets.map(target => target.runId)).toEqual([child.runId, child.runId]);
  expect(snapshot.nestedJoins?.[0].targets[0]).not.toHaveProperty("output");
  expect(manager.unjoinedDirectChildren(owner.runId)).toEqual([]);

  expect(() => manager.bindNestedJoin({ conversationId: owner.conversationId, runId: owner.runId }, [owner.runId]))
    .toThrow("not a descendant");
  expect(manager.runSnapshot(owner.runId).nestedJoins?.[1]).toMatchObject({ state: "failed" });
  expect(manager.runSnapshot(owner.runId).observerCount).toBe(0);
});
