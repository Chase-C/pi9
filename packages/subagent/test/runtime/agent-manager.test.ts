import { test, expect } from "vitest";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { completedRun } from "../../src/domain/agent-finalize.js";

const config = {
  name: "worker",
  description: "",
  systemPrompt: "",
  source: "project",
} as any;
const registry = { agents: new Map([["worker", config]]) } as any;
const ctx = { cwd: "/tmp" } as any;
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
  const manager = new AgentManager(registry, 2, runner, 1);
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

test("joins exact historical runs and remains stable across resume", async () => {
  const manager = new AgentManager(registry, 1, runner);
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
  const manager = new AgentManager(registry, 2, slow);
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
  expect(() => manager.bindJoin([parentRun.runId])).toThrow();
  await join.completion;
  expect(join.project()[0].status).toMatchObject({
    kind: "done",
    outcome: "aborted",
    error: "Conversation removed.",
  });
  expect(physical).toBe(true);
  release();
});

test("subtree join discovers late descendants and waits in root-first order", async () => {
  const gates = new Map<string, () => void>();
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    await new Promise<void>(done => gates.set(attempt.prompt, done));
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new AgentManager(registry, 8, controlled);
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
  const grand = grandStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  gates.get("root")!();
  await rootStart.completion;
  let finished = false;
  void join.completion.then(() => { finished = true; });
  await new Promise(done => setImmediate(done));
  expect(finished).toBe(false);
  gates.get("grand")!();
  await grandStart.completion;
  expect(finished).toBe(false);
  gates.get("child")!();
  await childStart.completion;
  await join.completion;

  expect(join.project().map(entry => [entry.runId, entry.conversationId])).toEqual([
    [root.runId, root.conversationId],
    [child.runId, child.conversationId],
    [grand.runId, grand.conversationId],
  ]);
  expect(join.project().map(output)).toEqual(["root", "child", "grand"]);
  join.release();
});

test("subtree join retains a bound descendant after removal", async () => {
  let releaseRoot!: () => void;
  const rootGate = new Promise<void>(done => { releaseRoot = done; });
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    if (attempt.prompt === "root") await rootGate;
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new AgentManager(registry, 4, controlled);
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
  expect(join.project().map(entry => entry.runId)).toEqual([root.runId, child.runId]);

  manager.removeConversation(child.conversationId);
  releaseRoot();
  await rootStart.completion;
  await join.completion;
  expect(join.project().map(entry => entry.runId)).toEqual([root.runId, child.runId]);
  expect(join.project().map(output)).toEqual(["root", "child"]);
  join.release();
});

test("children of a resumed run do not attach to an older run join", async () => {
  const manager = new AgentManager(registry, 4, runner);
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
  const manager = new AgentManager(registry, 1, runner);
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
