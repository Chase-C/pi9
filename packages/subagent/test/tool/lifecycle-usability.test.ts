import { test, expect } from "vitest";
import { completedGeneration, Conversation } from "../../src/conversation.js";
import { SubagentRuntime, type SubagentCaller } from "../../src/runtime.js";
import { cancelAction, defineSubagentTool, inspectAction, joinAction, listAction, removeAction, resumeAction, steerAction } from "../../src/tool.js";

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
  const executor = async (_ctx: any, conversation: any, generation: any) => {
    conversation.bindSession(generation, session());
    await gate;
    return completedGeneration(conversation, generation, "done");
  };
  const runtime = new SubagentRuntime(registry, 1, executor);
  const start = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "wait", label: "active" }]);
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
  const executor = async (_ctx: any, conversation: any, generation: any) => {
    conversation.bindSession(generation, session(steering));
    if (generation.kind === "spawn") await firstGate;
    return completedGeneration(conversation, generation, generation.prompt);
  };
  const runtime = new SubagentRuntime(registry, 1, executor);
  const initial = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "first", label: "history" }]);
  const identity = initial.starts[0] as any;
  await new Promise(done => setImmediate(done));
  await runtime.steerSubagent(identity.conversationId, "redirect");
  releaseFirst();
  await initial.completion;
  joinLatest(runtime, identity.conversationId);

  const resumed = runtime.startTasks(ctx, [{ kind: "resume", subagentId: identity.conversationId, prompt: "second" }]);
  await resumed.completion;

  const result = inspectAction(deps(runtime), {
    action: "inspect",
    subagentIds: [identity.conversationId],
  });
  const inspected = response(result).results[0];

  expect(result.details).toMatchObject({
    observedGenerations: [{ conversationId: identity.conversationId, generation: 2 }],
  });
  expect(JSON.parse(result.content[0].text)).not.toHaveProperty("observedGenerations");
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

test("cancelling a parent does not crash its in-flight nested join update", async () => {
  const parent = new Conversation("calm-parent" as any, config, {
    kind: "spawn",
    agent: "worker",
    label: "parent",
    prompt: "delegate",
  }, () => {});
  let update: (() => void) | undefined;
  let subscribed!: () => void;
  const subscription = new Promise<void>(resolve => { subscribed = resolve; });
  let completeJoin!: () => void;
  const joinCompletion = new Promise<void>(resolve => { completeJoin = resolve; });
  const binding = {
    owner: { conversationId: parent.conversationId, generation: 1 },
    attemptIndex: 0,
    targets: [{ conversationId: "calm-river", generation: 1 }],
    completion: joinCompletion,
    project: () => [{ conversationId: "calm-river", generation: 1, status: { kind: "running", startedAt: Date.now() } }],
    markJoined() {},
    release() {},
    interrupt() { completeJoin(); },
  };
  const runtime = {
    scheduler: { suspendConversationSlotDuring: (_parent: Conversation, wait: () => Promise<void>) => wait() },
    validateSubagentJoin() {},
    bindSubagentJoin: () => binding,
    onConversationUpdate(listener: () => void) { update = listener; subscribed(); return () => {}; },
    listConversations: () => [],
    generationSnapshot: () => { throw new Error("unavailable"); },
    conversationDisplay: () => ({ agentName: "worker", label: "child" }),
    unjoinedDirectChildGenerations: () => [],
    projectSubagent: (_id: string, caller: SubagentCaller) => ({
      ok: true,
      subagentId: "calm-river",
      agent: "worker",
      label: "child",
      status: "running",
      joined: false,
      actionHints: ["inspect", "join"],
      callerGeneration: caller.generation.number,
    }),
  } as any;
  const tool = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    parent,
    prepareInvocation: async () => ({ runtime: { maxTasksPerCall: 8 } }) as any,
  });
  const controller = new AbortController();
  const execution = tool.execute("join-call", { action: "join", subagentIds: ["calm-river"] }, controller.signal, () => {}, ctx);
  await subscription;

  parent.settle(parent.latestGeneration, "aborted", { error: "Generation cancelled." });
  expect(() => update?.()).not.toThrow();

  controller.abort();
  await execution;
});

test("cancel details correlate the exact generation without exposing it in public JSON", async () => {
  const actionDeps = {
    runtime: {
      cancelSubagent: async () => ({ conversationId: "calm-river", generation: 2, settled: true }),
      projectSubagent: () => ({
        ok: true,
        subagentId: "calm-river",
        agent: "worker",
        label: "cancelled task",
        status: "cancelled",
        joined: false,
        actionHints: ["inspect", "remove"],
      }),
    },
    agentRegistry: registry,
  } as any;

  const result = await cancelAction(actionDeps, { action: "cancel", subagentIds: ["calm-river"] } as any);

  expect(result.details).toMatchObject({
    observedGenerations: [{ conversationId: "calm-river", generation: 2 }],
  });
  expect(JSON.parse(result.content[0].text)).not.toHaveProperty("observedGenerations");
});

test("join rendering reports an unjoined resumed child from a historical owner generation", async () => {
  let releaseGrandparent!: () => void;
  let releaseParent!: () => void;
  let releaseResumedChild!: () => void;
  const gates = new Map([
    ["grandparent", new Promise<void>(done => { releaseGrandparent = done; })],
    ["parent", new Promise<void>(done => { releaseParent = done; })],
    ["child-again", new Promise<void>(done => { releaseResumedChild = done; })],
  ]);
  const executor = async (_ctx: any, conversation: any, generation: any) => {
    conversation.bindSession(generation, generation.kind === "resume" ? conversation.sessionForResume() : session());
    await gates.get(generation.prompt);
    return completedGeneration(conversation, generation, generation.prompt);
  };
  const runtime = new SubagentRuntime(registry, 3, executor);

  const grandparentStart = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "grandparent", label: "grandparent" }]);
  const grandparent = grandparentStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const grandparentCaller = runtime.generationCaller(grandparent);

  const parentStart = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "parent", label: "parent" }], { caller: grandparentCaller });
  const parent = parentStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const parentCaller = runtime.generationCaller(parent);
  const parentJoin = runtime.bindSubagentJoin([parent.conversationId], grandparentCaller);

  const childStart = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }], { caller: parentCaller });
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const childJoin = runtime.bindSubagentJoin([child.conversationId], parentCaller);
  await childJoin.completion;
  childJoin.markJoined();
  childJoin.release();

  const resumedChildStart = runtime.startTasks(ctx, [{ kind: "resume", subagentId: child.conversationId, prompt: "child-again" }], { caller: parentCaller });
  await new Promise(done => setImmediate(done));

  releaseParent();
  await parentStart.completion;
  await parentJoin.completion;
  parentJoin.markJoined();
  parentJoin.release();
  const resumedParent = runtime.startTasks(ctx, [{ kind: "resume", subagentId: parent.conversationId, prompt: "parent-again" }], { caller: grandparentCaller });
  await resumedParent.completion;

  releaseGrandparent();
  await grandparentStart.completion;
  const rendered = await joinAction(deps(runtime), { action: "join", subagentIds: [grandparent.conversationId] }, undefined, undefined);
  const historicalParent = (rendered.details as any).view.entries[0].joins[0].targets[0];

  expect(runtime.conversation(parent.conversationId).generations).toHaveLength(2);
  expect(historicalParent.background[0].entries).toEqual([expect.objectContaining({
    subagentId: child.conversationId,
    status: "running",
    detachedAtFinal: true,
  })]);

  releaseResumedChild();
  await resumedChildStart.completion;
});

test("unauthorized lifecycle failures do not expose canonical target metadata", async () => {
  const blocked = new Set(["first-root", "second-root", "child"]);
  const releases = new Map<string, () => void>();
  const gates = new Map([...blocked].map(prompt => [prompt, new Promise<void>(done => { releases.set(prompt, done); })]));
  const executor = async (_ctx: any, conversation: any, generation: any) => {
    conversation.bindSession(generation, session());
    const gate = gates.get(generation.prompt);
    if (gate) {
      await gate;
      return completedGeneration(conversation, generation, "done");
    }
    return conversation.settle(generation, "error", { error: "TOP SECRET FAILURE" });
  };
  const runtime = new SubagentRuntime(registry, 4, executor);
  const handles: Array<{ completion: Promise<unknown> }> = [];
  const start = async (prompt: string, caller?: SubagentCaller) => {
    const handle = runtime.startTasks(
      ctx,
      [{ kind: "spawn", agent: "worker", prompt, label: `SECRET ${prompt}` }],
      caller ? { caller } : {},
    );
    handles.push(handle);
    const identity = handle.starts[0] as any;
    await new Promise(done => setImmediate(done));
    if (!blocked.has(prompt)) await handle.completion;
    return identity;
  };
  const firstRoot = await start("first-root");
  const secondRoot = await start("second-root");
  const secondCaller = runtime.generationCaller(secondRoot);
  const child = await start("child", secondCaller);
  const childCaller = runtime.generationCaller(child);
  const leaf = await start("leaf", childCaller);
  const ownedFailureIdentity = await start("owned-failure");

  const unauthorizedCases = [
    {
      name: "sibling",
      target: secondRoot.conversationId,
      actionDeps: { ...deps(runtime), parent: runtime.generationCaller(firstRoot).conversation },
    },
    {
      name: "ancestor",
      target: secondRoot.conversationId,
      actionDeps: { ...deps(runtime), parent: runtime.generationCaller(child).conversation },
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
    messages: [{ kind: "steer", subagentId: ownedFailureIdentity.conversationId, message: "redirect" }],
  })).results[0];
  expect(ownedFailure).toMatchObject({
    ok: false,
    subagentId: ownedFailureIdentity.conversationId,
    label: "SECRET owned-failure",
    status: "failed",
    failure: "Subagent failed: TOP SECRET FAILURE",
    error: expect.stringContaining("cannot be steered"),
  });

  for (const release of releases.values()) release();
  await Promise.all(handles.map(handle => handle.completion));
});
