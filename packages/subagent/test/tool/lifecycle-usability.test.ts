import { test, expect } from "vitest";
import { completedRun } from "../../src/conversation.js";
import { SubagentRuntime } from "../../src/runtime.js";
import { cancelAction, inspectAction, joinAction, listAction, removeAction, resumeAction, steerAction } from "../../src/tool.js";

const knownModel = { provider: "test", id: "known" } as any;
const config = {
  name: "worker",
  description: "",
  systemPrompt: "",
  source: "project",
} as any;
const registry = { agents: new Map([["worker", config]]) } as any;
const ctx = {
  cwd: "/tmp",
  model: knownModel,
  modelRegistry: { getAll: () => [knownModel] },
} as any;
const session = (steering: string[] = []) => ({
  messages: [],
  subscribe: () => () => {},
  abort() {},
  steer(message: string) { steering.push(message); },
  getSteeringMessages() { return steering; },
  getFollowUpMessages() { return []; },
}) as any;
const deps = (runtime: SubagentRuntime) => ({ runtime, agentRegistry: registry });
const response = (result: any) => result.details.response;

function joinLatest(runtime: SubagentRuntime, subagentId: any): void {
  const binding = runtime.bindSubagentJoin([subagentId]);
  binding.markJoined();
  binding.release();
}

test("list joined=false includes active subagents and projects joined explicitly", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const runner = async (_ctx: any, agent: any, run: any) => {
    agent.bindSession(session());
    await gate;
    return completedRun(agent, run.runId, "done");
  };
  const runtime = new SubagentRuntime(registry, 1, runner);
  const start = runtime.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "wait", label: "active" }]);
  const identity = start.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const listed = response(listAction(deps(runtime), { action: "list", joined: false }));

  expect(listed.results).toMatchObject([{
    ok: true,
    subagentId: identity.conversationId,
    status: "running",
    joined: false,
  }]);

  release();
  await start.completion;
});

test("inspect separates current generation metrics from prior generation history", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(done => { releaseFirst = done; });
  const steering: string[] = [];
  const runner = async (_ctx: any, agent: any, run: any) => {
    agent.bindSession(session(steering));
    if (run.kind === "spawn") await firstGate;
    return completedRun(agent, run.runId, run.prompt);
  };
  const runtime = new SubagentRuntime(registry, 1, runner);
  const initial = runtime.startRun(ctx, [{ kind: "spawn", agent: "worker", prompt: "first", label: "history" }]);
  const identity = initial.starts[0] as any;
  await new Promise(done => setImmediate(done));
  await runtime.steerSubagent(identity.conversationId, "redirect");
  releaseFirst();
  await initial.completion;
  joinLatest(runtime, identity.conversationId);

  const resumed = runtime.startRun(ctx, [{ kind: "resume", subagentId: identity.conversationId, prompt: "second" }]);
  await resumed.completion;

  const inspected = response(inspectAction(deps(runtime), {
    action: "inspect",
    subagentIds: [identity.conversationId],
  })).results[0];

  expect(inspected).toMatchObject({
    generation: 2,
    metrics: {
      elapsedMs: expect.any(Number),
      turns: 0,
      compactions: 0,
      tokens: 0,
    },
    totalMetrics: {
      elapsedMs: expect.any(Number),
      turns: 0,
      compactions: 0,
      tokens: 0,
    },
    history: [
      {
        generation: 1,
        kind: "spawn",
        status: "completed",
        joined: true,
        elapsedMs: expect.any(Number),
        turns: 0,
        compactions: 0,
        tokens: 0,
        steers: [{ id: 1, state: "discarded" }],
      },
    ],
  });
  expect(inspected).not.toHaveProperty("attempt");
  expect(inspected).not.toHaveProperty("attemptMetrics");
  expect(inspected).not.toHaveProperty("elapsedMs");
  expect(inspected).not.toHaveProperty("turns");
  expect(inspected).not.toHaveProperty("compactions");
  expect(inspected.totalMetrics.elapsedMs).toBe(
    inspected.history[0].elapsedMs + inspected.metrics.elapsedMs,
  );
});

test("unauthorized lifecycle failures do not expose canonical target metadata", async () => {
  const runner = async (_ctx: any, agent: any, run: any) => {
    agent.bindSession(session());
    return agent.settle(run.runId, "error", { error: "TOP SECRET FAILURE" });
  };
  const runtime = new SubagentRuntime(registry, 4, runner);
  const start = async (prompt: string, caller?: { conversationId: any; runId: any }) => {
    const handle = runtime.startRun(
      ctx,
      [{ kind: "spawn", agent: "worker", prompt, label: `SECRET ${prompt}` }],
      caller ? { caller } : {},
    );
    await handle.completion;
    return handle.starts[0] as any;
  };
  const firstRoot = await start("first-root");
  const secondRoot = await start("second-root");
  const child = await start("child", { conversationId: secondRoot.conversationId, runId: secondRoot.runId });
  const leaf = await start("leaf", { conversationId: child.conversationId, runId: child.runId });

  const unauthorizedCases = [
    {
      name: "sibling",
      target: secondRoot.conversationId,
      actionDeps: { ...deps(runtime), parent: { conversationId: firstRoot.conversationId, runId: () => firstRoot.runId } },
    },
    {
      name: "ancestor",
      target: secondRoot.conversationId,
      actionDeps: { ...deps(runtime), parent: { conversationId: child.conversationId, runId: () => child.runId } },
    },
  ];

  for (const item of unauthorizedCases) {
    const results = [
      response(await resumeAction(item.actionDeps as any, { action: "resume", resumes: [{ kind: "resume", subagentId: item.target, prompt: "again" }] }, ctx as any)).results[0],
      response(await steerAction(item.actionDeps as any, { action: "steer", messages: [{ kind: "steer", subagentId: item.target, message: "redirect" }] })).results[0],
      response(await cancelAction(item.actionDeps as any, { action: "cancel", subagentIds: [item.target] })).results[0],
      response(inspectAction(item.actionDeps as any, { action: "inspect", subagentIds: [item.target] })).results[0],
      response(await joinAction(item.actionDeps as any, { action: "join", subagentIds: [item.target] }, undefined, undefined)).results[0],
      response(await removeAction(item.actionDeps as any, { action: "remove", subagentIds: [item.target] })).results[0],
    ];

    for (const result of results) {
      expect(result, item.name).toEqual({
        ok: false,
        subagentId: item.target,
        error: expect.stringMatching(/not (?:directly owned|a descendant)/),
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  }

  const indirect = { target: leaf.conversationId, actionDeps: deps(runtime) };
  const inspected = response(inspectAction(indirect.actionDeps as any, {
    action: "inspect",
    subagentIds: [indirect.target],
  })).results[0];
  expect(inspected).toMatchObject({
    ok: true,
    subagentId: indirect.target,
    label: "SECRET leaf",
    status: "failed",
    actionHints: ["inspect"],
  });

  const indirectMutations = [
    response(await resumeAction(indirect.actionDeps as any, { action: "resume", resumes: [{ kind: "resume", subagentId: indirect.target, prompt: "again" }] }, ctx as any)).results[0],
    response(await steerAction(indirect.actionDeps as any, { action: "steer", messages: [{ kind: "steer", subagentId: indirect.target, message: "redirect" }] })).results[0],
    response(await cancelAction(indirect.actionDeps as any, { action: "cancel", subagentIds: [indirect.target] })).results[0],
    response(await joinAction(indirect.actionDeps as any, { action: "join", subagentIds: [indirect.target] }, undefined, undefined)).results[0],
    response(await removeAction(indirect.actionDeps as any, { action: "remove", subagentIds: [indirect.target] })).results[0],
  ];
  for (const result of indirectMutations) {
    expect(result).toEqual({
      ok: false,
      subagentId: indirect.target,
      error: expect.stringContaining("not directly owned"),
    });
  }

  const ownedFailure = response(await steerAction(deps(runtime), {
    action: "steer",
    messages: [{ kind: "steer", subagentId: firstRoot.conversationId, message: "redirect" }],
  })).results[0];
  expect(ownedFailure).toMatchObject({
    ok: false,
    subagentId: firstRoot.conversationId,
    label: "SECRET first-root",
    status: "failed",
    failure: "Subagent failed: TOP SECRET FAILURE",
    error: expect.stringContaining("cannot be steered"),
  });
});
