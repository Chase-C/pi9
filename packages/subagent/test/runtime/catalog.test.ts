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
    conversationId: active.conversationId,
    prompt: "continue",
  }] as any);

  expect(resumed.starts[0]).toEqual({
    ok: false,
    inputIndex: 0,
    error: `Conversation ${active.conversationId} has queued run ${active.runId}. Wait for or join it before resuming.`,
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
  const busyStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "busy" }] as any);
  const busy = busyStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const batch = manager.startRun(ctx, [
    { kind: "resume", conversationId: busy.conversationId, prompt: "blocked" },
    { kind: "resume", conversationId: resumable.conversationId, prompt: "continue" },
  ] as any);

  expect(batch.starts[0]).toMatchObject({
    ok: false,
    inputIndex: 0,
    error: `Conversation ${busy.conversationId} has running run ${busy.runId}. Join it before resuming, or steer it while it runs.`,
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
    conversationId: terminal.conversationId,
    prompt: "continue",
  }] as any);

  expect(resumed.starts[0]).toEqual({
    ok: false,
    inputIndex: 0,
    error: `Conversation ${terminal.conversationId} cannot be resumed.`,
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
  const settlingError = `Conversation ${aborted.conversationId} is still settling cancelled run ${aborted.runId}. Wait for it to finish before resuming.`;

  expect(manager.runSnapshot(aborted.runId).status).toMatchObject({ kind: "done", outcome: "aborted" });
  expect(manager.conversation(aborted.conversationId).canResume).toBe(false);
  expect(manager.startRun(ctx, [{ kind: "resume", conversationId: aborted.conversationId, prompt: "too-early" }] as any).starts[0])
    .toMatchObject({ ok: false, error: settlingError });

  releaseAbort();
  await cancelling;
  expect(manager.conversation(aborted.conversationId).canResume).toBe(false);
  expect(manager.startRun(ctx, [{ kind: "resume", conversationId: aborted.conversationId, prompt: "still-early" }] as any).starts[0])
    .toMatchObject({ ok: false, error: settlingError });
  expect(executions).toBe(1);

  releaseExecution();
  await start.completion;
  expect(manager.conversation(aborted.conversationId).canResume).toBe(true);

  const resumed = manager.startRun(ctx, [{ kind: "resume", conversationId: aborted.conversationId, prompt: "continue" }] as any);
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

test("completed removal deletes exact runs, prevents resume, and reclaims capacity", async () => {
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

  await expect(manager.removeConversation(first.conversationId)).resolves.toEqual({
    removed: 1,
    conversationIds: [first.conversationId],
    errors: [],
  });
  expect(manager.listConversations()).toEqual([]);
  expect(() => manager.conversation(first.conversationId)).toThrow("Unknown conversation");
  expect((manager.startRun(ctx, [{
    kind: "resume",
    conversationId: first.conversationId,
    prompt: "again",
  }] as any).starts[0] as any).error).toContain("Unknown conversation");

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

test("bound joins cannot publish conversation updates after removal", async () => {
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

  expect(updates).toEqual([]);
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
      error: `Conversation ${active.conversationId} has active run ${active.runId}. Cancel and join it before removal.`,
    }],
  });
  expect(manager.conversation(active.conversationId).runs[0].status.kind).toBe("running");
  expect(manager.inspectRuns([active.runId])[0].snapshot.runId).toBe(active.runId);

  release();
  await start.completion;
});

test("removing an intermediate conversation reparents descendant ownership", async () => {
  const releases = new Map<string, () => void>();
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    if (attempt.prompt !== "child") await new Promise<void>(done => releases.set(attempt.prompt, done));
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 3, controlled);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  const owner = ownerStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    parent(owner.conversationId, owner.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "grand" }] as any,
    parent(child.conversationId, child.runId));
  const grand = grandStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await manager.removeConversation(child.conversationId);
  const caller = { conversationId: owner.conversationId, runId: owner.runId };
  let inspected: any;
  let nested: any;
  let accessError: unknown;
  try {
    inspected = manager.inspectRuns([grand.runId], caller)[0];
    await manager.steerRun(grand.runId, "redirect", caller);
    nested = manager.bindNestedJoin(caller, [grand.runId]);
    await manager.cancelRun(grand.runId, caller);
    await nested.completion;
  } catch (error) {
    accessError = error;
  } finally {
    nested?.release();
    releases.get("grand")!();
    releases.get("owner")!();
    await Promise.all([grandStart.completion, ownerStart.completion]);
  }

  if (accessError) throw accessError;
  expect(inspected.snapshot.runId).toBe(grand.runId);
  expect(manager.runLineage(grand.runId)).toEqual({ parentRunId: owner.runId, rootRunId: owner.runId, depth: 1 });
  expect(manager.conversation(grand.conversationId).parent).toEqual({ conversationId: owner.conversationId, runId: owner.runId });
  expect(() => manager.runSnapshot(child.runId)).toThrow(`Unknown run: ${child.runId}.`);
});

test("ownership contraction crosses multiple removed levels in either order", async () => {
  for (const order of [["first", "second"], ["second", "first"]] as const) {
    const releases = new Map<string, () => void>();
    const controlled = async (_ctx: any, agent: any, attempt: any) => {
      agent.bindSession(session());
      if (attempt.prompt === "owner" || attempt.prompt === "leaf") await new Promise<void>(done => releases.set(attempt.prompt, done));
      return completedRun(agent, attempt.runId, attempt.prompt);
    };
    const manager = new SubagentRuntime(registry, 4, controlled);
    const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
    const owner = ownerStart.starts[0] as any;
    await new Promise(done => setImmediate(done));
    const firstStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "first" }] as any,
      parent(owner.conversationId, owner.runId));
    await firstStart.completion;
    const first = firstStart.starts[0] as any;
    const secondStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "second" }] as any,
      parent(first.conversationId, first.runId));
    await secondStart.completion;
    const second = secondStart.starts[0] as any;
    const leafStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "leaf" }] as any,
      parent(second.conversationId, second.runId));
    const leaf = leafStart.starts[0] as any;
    await new Promise(done => setImmediate(done));

    const identities = { first, second };
    for (const name of order) await manager.removeConversation(identities[name].conversationId);
    const inspected = manager.inspectRuns([leaf.runId], { conversationId: owner.conversationId, runId: owner.runId });
    expect(inspected[0].snapshot.runId).toBe(leaf.runId);
    expect(manager.conversation(leaf.conversationId).parent).toEqual({ conversationId: owner.conversationId, runId: owner.runId });

    releases.get("leaf")!();
    releases.get("owner")!();
    await Promise.all([leafStart.completion, ownerStart.completion]);
  }
});

test("removing a root makes surviving children operational roots", async () => {
  let releaseChild!: () => void;
  const controlled = async (_ctx: any, agent: any, attempt: any) => {
    agent.bindSession(session());
    if (attempt.prompt === "child") await new Promise<void>(done => { releaseChild = done; });
    return completedRun(agent, attempt.runId, attempt.prompt);
  };
  const manager = new SubagentRuntime(registry, 2, controlled);
  const rootStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    parent(root.conversationId, root.runId));
  const child = childStart.starts[0] as any;
  await new Promise(done => setImmediate(done));

  await manager.removeConversation(root.conversationId);
  expect(manager.directSpawnedChildren(root.runId)).toEqual([]);
  expect(manager.conversation(child.conversationId).parent).toBeUndefined();
  expect(manager.inspectRuns([child.runId])[0].snapshot.runId).toBe(child.runId);

  releaseChild();
  await childStart.completion;
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
        error: `Conversation ${active.conversationId} has active run ${active.runId}. Cancel and join it before removal.`,
      },
      { conversationId: "amber-acorn", error: "Unknown conversation: amber-acorn." },
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

test("run lineage identifies recursive parents, roots, and depth", async () => {
  const manager = new SubagentRuntime(registry, 3, runner);
  const rootStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "root" }] as any);
  await rootStart.completion;
  const root = rootStart.starts[0] as any;
  const childStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "child" }] as any,
    parent(root.conversationId, root.runId));
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const grandStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "grand" }] as any,
    parent(child.conversationId, child.runId));
  await grandStart.completion;
  const grand = grandStart.starts[0] as any;

  const resumeStart = manager.startRun(ctx, [{ kind: "resume", conversationId: root.conversationId, prompt: "resume" }] as any);
  await resumeStart.completion;
  const resumed = resumeStart.starts[0] as any;

  expect(manager.runLineage(root.runId)).toEqual({ rootRunId: root.runId, depth: 0 });
  expect(manager.runLineage(child.runId)).toEqual({ parentRunId: root.runId, rootRunId: root.runId, depth: 1 });
  expect(manager.runLineage(grand.runId)).toEqual({ parentRunId: child.runId, rootRunId: root.runId, depth: 2 });
  expect(manager.runLineage(resumed.runId)).toEqual({ rootRunId: resumed.runId, depth: 0 });
});

test("removing a conversation reparents children from each parent run independently", async () => {
  const manager = new SubagentRuntime(registry, 4, runner);
  const ownerStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "owner" }] as any);
  await ownerStart.completion;
  const owner = ownerStart.starts[0] as any;
  const nestedStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "nested" }] as any,
    parent(owner.conversationId, owner.runId));
  await nestedStart.completion;
  const nested = nestedStart.starts[0] as any;
  const resumedStart = manager.startRun(ctx, [{ kind: "resume", conversationId: nested.conversationId, prompt: "resume" }] as any);
  await resumedStart.completion;
  const resumed = resumedStart.starts[0] as any;
  const initialChildStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "initial-child" }] as any,
    parent(nested.conversationId, nested.runId));
  const resumedChildStart = manager.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "resumed-child" }] as any,
    parent(nested.conversationId, resumed.runId));
  await Promise.all([initialChildStart.completion, resumedChildStart.completion]);
  const initialChild = initialChildStart.starts[0] as any;
  const resumedChild = resumedChildStart.starts[0] as any;

  await manager.removeConversation(nested.conversationId);

  expect(manager.runLineage(initialChild.runId)).toEqual({ parentRunId: owner.runId, rootRunId: owner.runId, depth: 1 });
  expect(manager.conversation(initialChild.conversationId).parent).toEqual({ conversationId: owner.conversationId, runId: owner.runId });
  expect(manager.runLineage(resumedChild.runId)).toEqual({ rootRunId: resumedChild.runId, depth: 0 });
  expect(manager.conversation(resumedChild.conversationId).parent).toBeUndefined();
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
  expect(prompts).toEqual(["focus on tests"]);
  expect(manager.conversation(started.conversationId).runs).toHaveLength(1);

  finish();
  await batch.completion;
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
  const resumed = manager.startRun(ctx, [{ kind: "resume", conversationId: target.conversationId, prompt: "continue" }]);
  expect(resumed.starts[0]).toMatchObject({
    ok: false,
    error: `Conversation ${target.conversationId} cannot be resumed.`,
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

test("nested completion tolerates a deleted owner", async () => {
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

  await manager.removeConversation(owner.conversationId);
  expect(() => manager.runSnapshot(owner.runId)).toThrow(`Unknown run: ${owner.runId}.`);
  finishTarget();
  await Promise.all([targetStart.completion, binding.completion]);
  expect(binding.project()[0].status).toMatchObject({ kind: "done", outcome: "completed" });
  expect(manager.conversation(target.conversationId).runs[0].observerCount).toBe(1);
  binding.release();
  expect(manager.conversation(target.conversationId).runs[0].observerCount).toBe(0);
});

test("nested interruption tolerates a deleted owner", async () => {
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

  await manager.removeConversation(owner.conversationId);
  expect(() => binding.interrupt("caller cancelled")).not.toThrow();
  expect(manager.conversation(target.conversationId).runs[0].observerCount).toBe(0);
  finishTarget();
  await targetStart.completion;
  expect(() => manager.runSnapshot(owner.runId)).toThrow(`Unknown run: ${owner.runId}.`);
});
