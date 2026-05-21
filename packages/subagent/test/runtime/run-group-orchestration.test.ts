import { test } from "vitest";
import assert from "node:assert/strict";

import { completedRun } from "../../src/domain/agent-finalize.js";
import { baseCtx, makeManager, makeSession, mergeRunners } from "../helpers/runtime.js";

test("orchestrator returns ordered per-run output and reports unknown agents and child failures", async () => {
  const calls: string[] = [];
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    calls.push(attempt.prompt);
    if (attempt.prompt === "three") throw new Error("child failed");
    agent.attach(makeSession());
    return completedRun(agent, `response:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([
      ["good", { name: "good", description: "d", systemPrompt: "s", source: "project" }],
      ["bad", { name: "bad", description: "d", systemPrompt: "s", source: "project" }],
    ]),
  };
  const manager = makeManager(registry as any, 2, runner);
  const results = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "good", prompt: "one", model: "m1" },
    { kind: "spawn", agent: "missing", prompt: "two" },
    { kind: "spawn", agent: "bad", prompt: "three" },
  ]);

  assert.deepEqual(calls.sort(), ["one", "three"]);
  assert.deepEqual(results.map(r => r.agent), ["good", "missing", "bad"]);
  assert.equal(results[0].status, "completed");
  assert.equal(results[0].output, "response:one");
  assert.equal(results[0].model, "m1");
  assert.equal(results[1].status, "error");
  assert.match(results[1].error ?? "", /Unknown agent/);
  assert.equal(results[2].status, "error");
  assert.match(results[2].error ?? "", /child failed/);
});

test("orchestrator handles a mixed batch of one spawn and one resume with resumed flags on both results and rendered AgentViews", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(session);
    return completedRun(agent, `spawn:${attempt.prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `resume:${attempt.prompt}`, true);
  };
  const registry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
      ["fresh", { name: "fresh", description: "d", systemPrompt: "s", source: "project", resumable: true }],
    ]),
  };
  const manager = makeManager(registry as any, 2, mergeRunners(runner, resumeRunner));

  const [seed] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "first" },
  ]);
  assert.equal(seed.status, "completed");
  assert.equal(seed.resumed, false);
  assert.ok(seed.sessionId);

  const updates: any[] = [];
  const results = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "fresh", prompt: "two" },
    { kind: "resume", sessionId: seed.sessionId!, prompt: "three" },
  ], update => updates.push(update));

  assert.equal(results.length, 2);
  assert.equal(results[0].agent, "fresh");
  assert.equal(results[0].resumed, false);
  assert.equal(results[0].output, "spawn:two");
  assert.equal(results[1].agent, "chatty");
  assert.equal(results[1].resumed, true);
  assert.equal(results[1].output, "resume:three");
  assert.equal(results[1].sessionId, seed.sessionId);

  const final = updates.at(-1);
  assert.equal(final.sessions.length, 2);
  assert.equal(final.sessions[0].resumed, false);
  assert.equal(final.sessions[1].resumed, true);
});

test("orchestrator.startBatch returns sessions synchronously and a resultsPromise mirroring run() for background:false", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = makeManager(registry as any, 2, runner);

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [
      { kind: "spawn", agent: "helper", prompt: "one" },
      { kind: "spawn", agent: "helper", prompt: "two" },
    ],
    undefined,
    { background: false },
  );

  assert.equal(typeof batch.groupId, "string");
  assert.ok(batch.groupId);
  assert.equal(batch.sessions.length, 2);
  assert.deepEqual(batch.sessions.map(s => s.config.name), ["helper", "helper"]);
  assert.deepEqual(batch.sessions.map(s => s.dispatch), ["foreground", "foreground"]);

  const results = await batch.resultsPromise;
  assert.deepEqual(results.map(r => r.status), ["completed", "completed"]);
  assert.deepEqual(results.map(r => r.output), ["done:one", "done:two"]);
});

test("orchestrator.startBatch with background:true returns sessions tagged dispatch:background and surfaces them in listSessions while running", async () => {
  let releaseRun: () => void;
  const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    await runGate;
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = makeManager(registry as any, 2, runner);

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "go" }],
    undefined,
    { background: true },
  );

  assert.equal(batch.sessions.length, 1);
  assert.equal(batch.sessions[0].dispatch, "background");

  const listed = manager.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].dispatch, "background");

  releaseRun!();
  await batch.resultsPromise;
});

test("orchestrator.startBatch background:true surfaces preflight failures as transient background attempts", async () => {
  const registry = { agents: new Map() };
  const manager = makeManager(registry as any, 2, async () => {
    throw new Error("runner should not be called");
  });

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [
      { kind: "spawn", agent: "missing", prompt: "unknown agent" },
      { kind: "resume", sessionId: "missing-session", prompt: "bad resume" },
    ],
    undefined,
    { background: true },
  );

  assert.deepEqual(batch.sessions.map(s => s.dispatch), ["background", "background"]);
  assert.deepEqual(batch.sessions.map(s => s.retention), ["transient", "transient"]);

  const results = await batch.resultsPromise;
  assert.deepEqual(results.map(r => r.status), ["error", "error"]);
});

test("orchestrator.startBatch background:true ignores parent signal abort and lets children complete", async () => {
  const seenSignals: Array<AbortSignal | undefined> = [];
  let releaseRun: () => void;
  const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any, signal: AbortSignal | undefined) => {
    seenSignals.push(signal);
    agent.attach(makeSession());
    await runGate;
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = makeManager(registry as any, 2, runner);
  const controller = new AbortController();

  const batch = manager.startRun(
    baseCtx(),
    controller.signal,
    [{ kind: "spawn", agent: "helper", prompt: "background work" }],
    undefined,
    { background: true },
  );

  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 5));

  releaseRun!();
  const results = await batch.resultsPromise;

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "completed");
  assert.equal(results[0].output, "done:background work");
  assert.notEqual(seenSignals[0], controller.signal);
});

test("orchestrator.startBatch background:true promotes resumed sessions to background and remove scope=background selects them", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(session);
    return completedRun(agent, `seed:${attempt.prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `resumed:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 2, mergeRunners(runner, resumeRunner));
  const [seed] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial" },
  ]);

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "resume", sessionId: seed.sessionId!, prompt: "follow-up" }],
    undefined,
    { background: true },
  );

  assert.equal(batch.sessions.length, 1);
  assert.equal(batch.sessions[0].id, seed.sessionId);
  assert.equal(batch.sessions[0].dispatch, "background");

  const [resumed] = await batch.resultsPromise;
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.sessionId, seed.sessionId);

  const listed = manager.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, seed.sessionId);
  assert.equal(listed[0].dispatch, "background");

  const result = await manager.remove({ scope: "background" });
  assert.equal(result.removed, 1);
  assert.deepEqual(result.sessionIds, [seed.sessionId]);
  assert.deepEqual(manager.listSessions(), []);
});

test("orchestrator.run forwards parentSessionId to every spawned agent's view and result", async () => {
  const seenParents: Array<string | undefined> = [];
  const runner = async (_ctx: any, agent: any) => {
    seenParents.push(agent.parentSessionId);
    agent.attach(makeSession());
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = makeManager(registry as any, 2, runner);

  const results = await manager.run(
    baseCtx(),
    undefined,
    [
      { kind: "spawn", agent: "helper", prompt: "one" },
      { kind: "spawn", agent: "helper", prompt: "two" },
    ],
    undefined,
    { parentSessionId: "parent-1" },
  );

  assert.deepEqual(seenParents, ["parent-1", "parent-1"]);
  assert.deepEqual(results.map(r => r.parentSessionId), ["parent-1", "parent-1"]);
});
