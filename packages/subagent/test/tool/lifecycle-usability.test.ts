import { test, expect } from "vitest";
import { completedRun } from "../../src/conversation.js";
import { SubagentRuntime } from "../../src/runtime.js";
import { inspectAction, listAction } from "../../src/tool.js";

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
