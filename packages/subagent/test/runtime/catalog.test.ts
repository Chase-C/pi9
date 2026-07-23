import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, expect } from "vitest";
import { SubagentRuntime } from "../../src/runtime.js";
import { completedRun } from "../../src/conversation.js";

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
const parent = (conversationId: any, runId: any) => ({ parent: { conversationId, runId } });
const output = (entry: any) =>
  entry.status.kind === "done" ? entry.status.output : undefined;

test("ordered starts reserve capacity and resumes work at capacity", async () => {
  const manager = new SubagentRuntime(registry, 2, runner, 1);
  const batch = manager.startRun(ctx, [
    { kind: "spawn", agent: "worker", prompt: "one" },
    { kind: "spawn", agent: "worker", prompt: "two" },
  ] as any);
  expect(batch.starts.map(start => start.ok)).toEqual([true, false]);
  expect((batch.starts[1] as any).error).toContain("Remove terminal conversations");

  await batch.completion;
  const first = batch.starts[0] as any;
  const resumed = manager.startRun(ctx, [{
    kind: "resume",
    conversationId: first.conversationId,
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

test("joins exact historical runs and remains stable across resume", async () => {
  const manager = new SubagentRuntime(registry, 1, runner);
  const initial = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "old",
  }] as any);
  await initial.completion;
  const first = initial.starts[0] as any;

  expect(() => manager.bindJoin([first.runId, "missing-run" as any])).toThrow();
  expect(manager.conversation(first.conversationId).runs[0].observerCount).toBe(0);
  const join = manager.bindJoin([first.runId]);
  expect(manager.conversation(first.conversationId).runs[0].observerCount).toBe(1);

  const resumed = manager.startRun(ctx, [{
    kind: "resume",
    conversationId: first.conversationId,
    prompt: "new",
  }] as any);
  await resumed.completion;
  await join.completion;
  expect(join.project()[0].status).toMatchObject({
    kind: "done",
    outcome: "completed",
    output: "old",
  });
  join.release();
});

test("completed removal preserves exact runs, prevents resume, and reclaims capacity", async () => {
  const manager = new SubagentRuntime(registry, 1, runner, 1);
  const initial = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "old",
  }] as any);
  await initial.completion;
  const first = initial.starts[0] as any;
  const resumed = manager.startRun(ctx, [{
    kind: "resume",
    conversationId: first.conversationId,
    prompt: "new",
  }] as any);
  await resumed.completion;
  const second = resumed.starts[0] as any;

  expect(manager.removeConversation(first.conversationId)).toMatchObject({ removed: 1, aborted: 0 });
  expect(manager.listConversations()).toEqual([]);
  expect(() => manager.conversation(first.conversationId)).toThrow("Unknown conversation");
  expect((manager.startRun(ctx, [{
    kind: "resume",
    conversationId: first.conversationId,
    prompt: "again",
  }] as any).starts[0] as any).error).toContain("Unknown conversation");

  const join = manager.bindJoin([first.runId, second.runId]);
  await join.completion;
  expect(join.project().map(output)).toEqual(["old", "new"]);
  join.release();

  const replacement = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "replacement",
  }] as any);
  expect(replacement.starts[0]).toMatchObject({ ok: true });
  await replacement.completion;
});

test("removal terminalizes immediately, wakes joins, and leaves children", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let physical = false;
  const slow = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession({
      ...session(),
      abort() {
        physical = true;
        return gate;
      },
    });
    if (attempt.prompt === "parent") await gate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, slow);
  const parentStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "parent",
  }] as any);
  const parentRun = parentStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const childStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "child",
  }] as any, parent(parentRun.conversationId, parentRun.runId));
  const child = childStart.starts[0] as any;
  const join = manager.bindJoin([parentRun.runId]);

  const removed = manager.removeConversation(parentRun.conversationId);
  expect(removed.aborted).toBe(1);
  expect(manager.listConversations().map(value => value.conversationId)).toContain(child.conversationId);
  const detachedJoin = manager.bindJoin([parentRun.runId]);
  await Promise.all([join.completion, detachedJoin.completion]);
  for (const binding of [join, detachedJoin]) {
    expect(binding.project()[0].status).toMatchObject({
      kind: "done",
      outcome: "aborted",
      error: "Conversation removed.",
    });
    binding.release();
  }
  expect(physical).toBe(true);
  release();
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

test("exact root join remains exact after conversations were removed", async () => {
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

  manager.removeConversation(child.conversationId);
  manager.removeConversation(root.conversationId);
  manager.removeConversation(grand.conversationId);
  const join = manager.bindJoin([root.runId]);
  await join.completion;
  expect(join.project().map(entry => [entry.runId, entry.conversationId])).toEqual([[root.runId, root.conversationId]]);
  expect(join.project().map(output)).toEqual(["root"]);
  join.release();
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

  manager.removeConversation(child.conversationId);
  releaseRoot();
  await rootStart.completion;
  await join.completion;
  expect(join.project().map(entry => entry.runId)).toEqual([root.runId]);
  expect(join.project().map(output)).toEqual(["root"]);
  join.release();
});

test("children of a resumed run do not attach to an older run join", async () => {
  const manager = new SubagentRuntime(registry, 4, runner);
  const firstStart = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "old",
  }] as any);
  await firstStart.completion;
  const first = firstStart.starts[0] as any;
  const oldJoin = manager.bindJoin([first.runId]);

  const resumedStart = manager.startRun(ctx, [{
    kind: "resume",
    conversationId: first.conversationId,
    prompt: "new",
  }] as any);
  await resumedStart.completion;
  const resumed = resumedStart.starts[0] as any;
  const child = manager.startRun(ctx, [{
    kind: "spawn",
    agent: "worker",
    prompt: "new-child",
  }] as any, parent(first.conversationId, resumed.runId));
  await child.completion;

  expect(oldJoin.project().map(entry => entry.runId)).toEqual([first.runId]);
  oldJoin.release();
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

test("detached owner snapshot records nested completion after removal", async () => {
  let finishTarget!: () => void;
  const targetGate = new Promise<void>(resolve => { finishTarget = resolve; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    if (attempt.prompt === "target") await targetGate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const targetStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "target" }] as any,
    parent(owner.conversationId, owner.runId));
  const target = targetStart.starts[0] as any;
  await new Promise(resolve => setImmediate(resolve));
  const binding = manager.bindNestedJoin({ conversationId: owner.conversationId, runId: owner.runId }, [target.runId]);

  manager.removeConversation(owner.conversationId);
  finishTarget();
  await Promise.all([targetStart.completion, binding.completion]);
  expect(manager.runSnapshot(owner.runId).nestedJoins?.[0]).toMatchObject({ state: "completed" });
  expect(manager.conversation(target.conversationId).runs[0].observerCount).toBe(1);
  binding.release();
  expect(manager.conversation(target.conversationId).runs[0].observerCount).toBe(0);
});

test("detached owner snapshot records explicit nested interruption", async () => {
  let finishTarget!: () => void;
  const targetGate = new Promise<void>(resolve => { finishTarget = resolve; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    if (attempt.prompt === "target") await targetGate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const targetStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "target" }] as any,
    parent(owner.conversationId, owner.runId));
  const target = targetStart.starts[0] as any;
  await new Promise(resolve => setImmediate(resolve));
  const binding = manager.bindNestedJoin({ conversationId: owner.conversationId, runId: owner.runId }, [target.runId]);

  manager.removeConversation(owner.conversationId);
  binding.interrupt("caller cancelled");
  expect(manager.runSnapshot(owner.runId).nestedJoins?.[0]).toMatchObject({ state: "interrupted", error: "caller cancelled" });
  expect(manager.conversation(target.conversationId).runs[0].observerCount).toBe(0);
  finishTarget();
  await targetStart.completion;
  expect(manager.runSnapshot(owner.runId).nestedJoins?.[0]).toMatchObject({ state: "interrupted", error: "caller cancelled" });
});
