import { test } from "vitest";
import assert from "node:assert/strict";

import { AgentManager } from "../../src/runtime/agent-manager.js";
import { Agent } from "../../src/domain/agent.js";
import { completedRun, interruptedRun } from "../../src/domain/agent-result.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/ui/settings.js";

type AnyManager = AgentManager;
type FakeRegistry = { agents: Map<string, any>; reload?: () => Promise<void>; summarizeAgent?: () => string };

const baseCtx = () => ({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } } as any);
const makeSession = () => ({
  messages: [] as any[],
  subscribe: () => () => {},
  prompt: async () => {},
  abort: () => {},
});
const merge = (spawn: any, resume?: any) =>
  (ctx: any, agent: any, attempt: any, signal: any) =>
    attempt.kind === "resume" ? (resume ?? spawn)(ctx, agent, attempt, signal) : spawn(ctx, agent, attempt, signal);

test("AgentManager.run carries the input label on unknown-agent synthetic results and views", async () => {
  const registry: FakeRegistry = { agents: new Map() };
  const manager = new AgentManager(registry as any, 2, async () => ({ status: "completed" }) as any);

  let lastUpdate: any;
  const results = await manager.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "missing", prompt: "do work", label: "researcher" }],
    update => { lastUpdate = update; },
  );

  assert.equal(results[0].label, "researcher");
  assert.equal(lastUpdate.sessions[0].label, "researcher");
});

test("AgentManager.listSessions returns all retained sessions when called with no filter", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(session);
    return completedRun(agent, "ok");
  };
  const registry: FakeRegistry = {
    agents: new Map([["good", { name: "good", description: "", systemPrompt: "", source: "project", resumable: true, tools: [] }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner);
  await manager.run(baseCtx(), undefined, [{ kind: "spawn", agent: "good", prompt: "go" }]);

  const all = manager.listSessions();
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "retained");
});

test("manager returns ordered per-run output and reports unknown agents and child failures", async () => {
  const calls: string[] = [];
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    calls.push(prompt);
    if (prompt === "three") throw new Error("child failed");
    agent.attach(makeSession());
    return completedRun(agent, `response:${prompt}`);
  };
  const registry = {
    agents: new Map([
      ["good", { name: "good", description: "d", systemPrompt: "s", source: "project" }],
      ["bad", { name: "bad", description: "d", systemPrompt: "s", source: "project" }],
    ]),
  };
  const manager = new AgentManager(registry as any, 2, runner);
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

test("manager marks runner rejections before start as terminal error in grouped progress", async () => {
  const runner = async () => { throw new Error("setup failed before start"); };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner as any);
  const updates: any[] = [];

  const results = await manager.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "work" }],
    update => updates.push(update),
  );

  assert.equal(results[0].status, "error");
  assert.match(results[0].error ?? "", /setup failed before start/);
  const final = updates.at(-1);
  assert.equal(final.active, false);
  assert.equal(final.sessions.length, 1);
  assert.equal(final.sessions[0].status.kind, "done");
  assert.equal(final.sessions[0].status.outcome, "error");
  assert.match(final.sessions[0].status.snippet, /setup failed before start/);
  assert.deepEqual(manager.listSessions(), []);
});

test("manager returns skipped result and final group row for queued task whose signal aborted before it can start", async () => {
  const calls: string[] = [];
  let finishFirst: () => void;
  const firstCanFinish = new Promise<void>(resolve => { finishFirst = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    calls.push(prompt);
    agent.attach(makeSession());
    if (prompt === "one") await firstCanFinish;
    return completedRun(agent, `done:${prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner);
  const controller = new AbortController();
  const updates: any[] = [];

  const pending = manager.run(
    baseCtx(),
    controller.signal,
    [
      { kind: "spawn", agent: "helper", prompt: "one" },
      { kind: "spawn", agent: "helper", prompt: "two" },
    ],
    update => updates.push(update),
  );

  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  finishFirst!();
  const results = await pending;

  assert.deepEqual(calls, ["one"]);
  assert.equal(results[0].status, "completed");
  assert.equal(results[1].status, "skipped");
  assert.equal(results[1].resumable, false);
  const final = updates.at(-1);
  assert.deepEqual(
    final.sessions.map((s: any) => s.status.kind === "done" ? s.status.outcome : s.status.kind),
    ["completed", "skipped"],
  );
  assert.deepEqual(manager.listSessions(), []);
});

test("manager does not expose skipped resumable tasks as sessions", async () => {
  let finishFirst: () => void;
  const firstCanFinish = new Promise<void>(resolve => { finishFirst = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    await firstCanFinish;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([
      ["blocker", { name: "blocker", description: "d", systemPrompt: "s", source: "project", resumable: false }],
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
    ]),
  };
  const manager = new AgentManager(registry as any, 1, runner);
  const controller = new AbortController();

  const pending = manager.run(baseCtx(), controller.signal, [
    { kind: "spawn", agent: "blocker", prompt: "one" },
    { kind: "spawn", agent: "chatty", prompt: "two" },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  finishFirst!();
  const results = await pending;

  assert.equal(results[1].status, "skipped");
  assert.equal(results[1].resumable, false);
  assert.equal(Object.prototype.hasOwnProperty.call(results[1], "sessionId"), false);
  assert.deepEqual(manager.listSessions(), []);
  assert.deepEqual(await manager.remove({ scope: "non-running" }), { removed: 0, aborted: 0, sessionIds: [], errors: [] });
});

test("manager does not expose or resume non-resumable completed sessions", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner);

  const results = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], "sessionId"), false);
  assert.deepEqual(manager.listSessions(), []);
  const [retried] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: "anything", prompt: "follow up" },
  ]);
  assert.equal(retried.status, "error");
  assert.equal(retried.resumed, true);
  assert.match(retried.error ?? "", /Unknown resumable subagent session/);
});

test("manager discards a completed session when a task overrides resumable to false at spawn or resume", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    return completedRun(agent, `out:${attempt.prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `follow:${attempt.prompt}`, true);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 1, merge(runner, resumeRunner));

  // Spawn-side override: session is never retained.
  const spawnResults = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "spawn-only", resumable: false },
  ]);
  assert.equal(spawnResults[0].status, "completed");
  assert.equal(spawnResults[0].resumable, false);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnResults[0], "sessionId"), false);
  assert.deepEqual(manager.listSessions(), []);

  // Resume-side override: session retained on initial spawn, then discarded on resume.
  const [seed] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial" },
  ]);
  assert.equal(manager.listSessions().length, 1);
  const [resumed] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: seed.sessionId!, prompt: "tear down", resumable: false },
  ]);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.resumable, false);
  assert.deepEqual(manager.listSessions(), []);
});

test("manager retains only resumable interrupted sessions inspect-clear only after parent cancellation settles", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any, signal: AbortSignal) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return interruptedRun(agent, "cancelled by parent");
  };
  const registry = {
    agents: new Map([
      ["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }],
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
    ]),
  };
  const manager = new AgentManager(registry as any, 2, runner as any);
  const controller = new AbortController();

  const pending = manager.run(baseCtx(), controller.signal, [
    { kind: "spawn", agent: "oneshot", prompt: "one" },
    { kind: "spawn", agent: "chatty", prompt: "two" },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  const results = await pending;

  assert.deepEqual(results.map(result => result.status), ["interrupted", "interrupted"]);
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], "sessionId"), false);
  assert.ok(results[1].sessionId);

  const sessions = manager.listSessions();
  assert.deepEqual(sessions.map(session => session.config.name), ["chatty"]);
  assert.equal(sessions[0].status.kind, "done");
  assert.equal(sessions[0].status.kind === "done" && sessions[0].status.outcome, "interrupted");

  const [retried] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: results[1].sessionId!, prompt: "follow up" },
  ]);
  assert.equal(retried.status, "error");
  assert.equal(retried.resumed, true);
  assert.match(retried.error ?? "", /while it is interrupted/);
  assert.deepEqual(await manager.remove({ sessionIds: [results[1].sessionId!] }), { removed: 1, aborted: 0, sessionIds: [results[1].sessionId!], errors: [] });
  assert.deepEqual(manager.listSessions(), []);
});

test("manager retains a completed session when a task overrides resumable to true", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(session);
    return completedRun(agent, `done:${prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `follow:${prompt}`);
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = new AgentManager(registry as any, 1, merge(runner, resumeRunner));

  const results = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work", resumable: true },
  ]);

  assert.equal(results[0].resumable, true);
  assert.ok(results[0].sessionId);
  assert.deepEqual(
    manager.listSessions().map(s => [s.id, s.config.name, s.config.resumable]),
    [[results[0].sessionId, "oneshot", true]],
  );

  const [resumed] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: results[0].sessionId!, prompt: "again" },
  ]);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, "follow:again");
});

test("manager preserves a stored label across unlabeled resume and overwrites on labeled resume", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(session);
    return completedRun(agent, `response:${attempt.prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `follow:${attempt.prompt}`, true);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 1, merge(runner, resumeRunner));

  const [initial] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "one", label: "original" },
  ]);
  assert.equal(initial.label, "original");
  assert.ok(initial.sessionId);

  const [unlabeledResume] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: initial.sessionId!, prompt: "two" },
  ]);
  assert.equal(unlabeledResume.label, "original");
  assert.equal(manager.listSessions()[0].label, "original");

  const [backgroundEntry] = await manager.backgroundResults([initial.sessionId!]) as any[];
  assert.equal(backgroundEntry.ready, true);
  assert.equal(backgroundEntry.result.label, "original");

  const [renamedResume] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: initial.sessionId!, prompt: "three", label: "renamed" },
  ]);
  assert.equal(renamedResume.label, "renamed");
  assert.equal(manager.listSessions()[0].label, "renamed");
});

test("manager reports queued resume elapsed from the current attempt time", async () => {
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  let releaseBlocker: (() => void) | undefined;
  try {
    const retainedSession = makeSession();
    const registry = {
      agents: new Map([
        ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
        ["blocker", { name: "blocker", description: "d", systemPrompt: "s", source: "project", resumable: false }],
      ]),
    };
    const runner = async (_ctx: any, agent: any, attempt: any) => {
      agent.attach(agent.agentName === "chatty" ? retainedSession : makeSession());
      if (agent.agentName === "blocker") await new Promise<void>(resolve => { releaseBlocker = resolve; });
      return completedRun(agent, `done:${attempt.prompt}`);
    };
    const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
      agent.attach(agent.retainedSession()!);
      return completedRun(agent, `follow:${attempt.prompt}`, true);
    };
    const manager = new AgentManager(registry as any, 1, merge(runner, resumeRunner));

    const [initial] = await manager.run(baseCtx(), undefined, [
      { kind: "spawn", agent: "chatty", prompt: "old" },
    ]);
    assert.ok(initial.sessionId);

    now = 100_000;
    const batch = manager.startBatch(baseCtx(), undefined, [
      { kind: "spawn", agent: "blocker", prompt: "block" },
      { kind: "resume", sessionId: initial.sessionId!, prompt: "queued" },
    ], undefined, { background: true });

    await new Promise(resolve => setImmediate(resolve));
    now = 100_250;
    const [queued] = await manager.backgroundResults([initial.sessionId!]) as any[];
    assert.equal(queued.ready, false);
    assert.equal(queued.status, "queued");
    assert.equal(queued.elapsedMs, 250);
    assert.equal(manager.listSessions().find(s => s.id === initial.sessionId)!.status.kind, "queued");

    releaseBlocker?.();
    await batch.resultsPromise;
  } finally {
    Date.now = realNow;
  }
});

test("manager retains, resumes, lists, and clears completed resumable sessions", async () => {
  let runEmit: ((event: any) => void) | undefined;
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    const session = {
      messages: [],
      subscribe(handler: any) { runEmit = handler; return () => { runEmit = undefined; }; },
      prompt: async () => {},
      abort: () => {},
    };
    agent.attach(session);
    runEmit!({ type: "turn_end" });
    return completedRun(agent, `response:${prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(agent.retainedSession()!);
    runEmit!({ type: "turn_end" });
    return completedRun(agent, `follow:${prompt}`);
  };

  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 2, merge(runner, resumeRunner));
  const results = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "one" },
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(results[0].output, "response:one");
  assert.ok(results[0].sessionId);
  assert.deepEqual(manager.listSessions().map(s => s.id), [results[0].sessionId]);

  const [resumed] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: results[0].sessionId!, prompt: "two" },
  ]);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, "follow:two");
  assert.equal(resumed.prompt, "two");
  assert.equal(resumed.sessionId, results[0].sessionId);

  const retained = manager.listSessions()[0];
  assert.equal(retained.id, results[0].sessionId);
  assert.equal(retained.status.kind, "done");
  assert.equal(retained.status.kind === "done" && retained.status.outcome, "completed");
  assert.equal(retained.status.kind === "done" && retained.status.snippet, "follow:two");

  assert.deepEqual(await manager.remove({ sessionIds: [results[0].sessionId!] }), { removed: 1, aborted: 0, sessionIds: [results[0].sessionId!], errors: [] });
  assert.deepEqual(manager.listSessions(), []);
});

test("manager rejects duplicate resume tasks without corrupting the retained session", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(session);
    return completedRun(agent, `old:${prompt}`);
  };
  let finishResume: () => void;
  const resumeCanFinish = new Promise<void>(resolve => { finishResume = resolve; });
  const resumePrompts: string[] = [];
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    resumePrompts.push(prompt);
    if (prompt !== "first follow-up") throw new Error(`duplicate resume runner invoked for ${prompt}`);
    agent.attach(agent.retainedSession()!);
    await resumeCanFinish;
    return completedRun(agent, `new:${prompt}`);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 2, merge(runner, resumeRunner));
  const [first] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial prompt" },
  ]);

  const pending = manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: first.sessionId!, prompt: "first follow-up" },
    { kind: "resume", sessionId: first.sessionId!, prompt: "duplicate follow-up" },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(resumePrompts, ["first follow-up"]);
  finishResume!();

  const [resumed, duplicate] = await pending;
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, "new:first follow-up");
  assert.equal(resumed.sessionId, first.sessionId);

  assert.equal(duplicate.status, "error");
  assert.equal(duplicate.prompt, "duplicate follow-up");
  assert.equal(duplicate.resumed, true);
  assert.equal(duplicate.sessionId, first.sessionId);
  assert.match(duplicate.error ?? "", /already.*resum/i);

  const sessions = manager.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, first.sessionId);
  assert.equal(sessions[0].status.kind, "done");
  assert.equal(sessions[0].status.kind === "done" && sessions[0].status.outcome, "completed");
  assert.equal(sessions[0].status.kind === "done" && sessions[0].status.snippet, "new:first follow-up");
});

test("manager reports resume setup failure as the follow-up prompt error without returning prior completion", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(session);
    return completedRun(agent, `old:${prompt}`);
  };
  const resumeRunner = async () => { throw new Error("resume setup exploded"); };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 1, merge(runner, resumeRunner) as any);
  const [first] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial prompt" },
  ]);

  const [resumed] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: first.sessionId!, prompt: "follow-up prompt" },
  ]);

  assert.equal(resumed.status, "error");
  assert.equal(resumed.prompt, "follow-up prompt");
  assert.match(resumed.error ?? "", /resume setup exploded/);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.output, undefined);
  assert.notEqual(resumed.status, first.status);
  assert.notEqual(resumed.output, first.output);
});

test("manager keeps a retained completed session retryable across one or more pre-attach resume failures", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(session);
    return completedRun(agent, `old:${prompt}`);
  };
  let resumeAttempts = 0;
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    resumeAttempts += 1;
    if (resumeAttempts <= 2) throw new Error(`resume failed #${resumeAttempts}`);
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `new:${prompt}`);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 1, merge(runner, resumeRunner));
  const [first] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial prompt" },
  ]);

  // Two consecutive failures keep the session retryable each time.
  for (const attempt of [1, 2] as const) {
    const [failed] = await manager.run(baseCtx(), undefined, [
      { kind: "resume", sessionId: first.sessionId!, prompt: `try ${attempt}` },
    ]);
    assert.equal(failed.status, "error", `try ${attempt}: expected error`);
    assert.equal(failed.error, `resume failed #${attempt}`);
    const view = manager.listSessions()[0];
    assert.equal(view.status.kind === "done" && view.status.outcome, "error");
    assert.equal(view.status.kind === "done" && view.status.snippet, `resume failed #${attempt}`);
    assert.equal(view.config.resumable, true);
  }

  // Third attempt succeeds.
  const [retried] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: first.sessionId!, prompt: "successful follow-up" },
  ]);
  assert.equal(retried.status, "completed");
  assert.equal(retried.output, "new:successful follow-up");
  assert.equal(retried.sessionId, first.sessionId);
  const finalView = manager.listSessions()[0];
  assert.equal(finalView.status.kind === "done" && finalView.status.outcome, "completed");
  assert.equal(finalView.status.kind === "done" && finalView.status.snippet, "new:successful follow-up");
});

test("manager reports queued cancelled resume as skipped follow-up and keeps retained session retryable", async () => {
  let finishBlocker: () => void;
  const blockerCanFinish = new Promise<void>(resolve => { finishBlocker = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    if (prompt === "blocker prompt") await blockerCanFinish;
    return completedRun(agent, `output:${prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `resumed:${prompt}`);
  };
  const registry = {
    agents: new Map([
      ["blocker", { name: "blocker", description: "d", systemPrompt: "s", source: "project", resumable: false }],
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
    ]),
  };
  const manager = new AgentManager(registry as any, 1, merge(runner, resumeRunner));
  const [first] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial prompt" },
  ]);

  const controller = new AbortController();
  const updates: any[] = [];
  const pending = manager.run(
    baseCtx(),
    controller.signal,
    [
      { kind: "spawn", agent: "blocker", prompt: "blocker prompt" },
      { kind: "resume", sessionId: first.sessionId!, prompt: "follow-up prompt", resumable: false },
    ],
    update => updates.push(update),
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  finishBlocker!();
  const results = await pending;
  const resumed = results[1];

  assert.equal(resumed.status, "skipped");
  assert.equal(resumed.prompt, "follow-up prompt");
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.output, undefined);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(resumed.resumable, true);
  assert.notEqual(resumed.output, first.output);

  const finalResumeView = updates.at(-1).sessions[1];
  assert.equal(finalResumeView.resumed, true);
  assert.equal(finalResumeView.status.kind, "done");
  assert.equal(finalResumeView.status.outcome, "skipped");
  assert.equal(finalResumeView.status.snippet, "Agent skipped.");
  assert.equal(finalResumeView.config.resumable, true);

  const list = manager.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, first.sessionId);
  assert.equal(list[0].status.kind, "done");
  assert.equal(list[0].status.kind === "done" && list[0].status.outcome, "skipped");
  assert.equal(list[0].status.kind === "done" && list[0].status.snippet, "Agent skipped.");
  assert.equal(list[0].config.resumable, true);

  const [retried] = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: first.sessionId!, prompt: "retry prompt" },
  ]);
  assert.equal(retried.status, "completed");
  assert.equal(retried.output, "resumed:retry prompt");
  assert.equal(retried.sessionId, first.sessionId);
});

test("manager emits grouped progress rows in input order including unknown agents", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, `done:${prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);
  const snapshots: any[] = [];

  const results = await manager.run(
    baseCtx(),
    undefined,
    [
      { kind: "spawn", agent: "helper", prompt: "one" },
      { kind: "spawn", agent: "missing", prompt: "two" },
      { kind: "spawn", agent: "helper", prompt: "three" },
    ],
    update => snapshots.push(update.sessions),
  );

  assert.deepEqual(results.map(r => r.agent), ["helper", "missing", "helper"]);
  assert.deepEqual(results.map(r => r.status), ["completed", "error", "completed"]);

  const initial = snapshots[0];
  assert.equal(initial.length, 3);
  assert.deepEqual(
    initial.map((row: any) => [row.config.name, row.status.kind === "done" ? row.status.outcome : row.status.kind, row.inputIndex]),
    [["helper", "queued", 0], ["missing", "error", 1], ["helper", "queued", 2]],
  );
  assert.match(initial[1].status.snippet, /Unknown agent: missing/);
});

test("manager keeps emitting active batch updates for spinner animation even without agent events", async () => {
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  let finish: () => void;
  const blocker = new Promise<void>(resolve => { finish = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    await blocker;
    return completedRun(agent, "done");
  };
  const manager = new AgentManager(registry as any, 1, runner);
  const snapshots: any[] = [];

  const pending = manager.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "work" }],
    update => snapshots.push(update.sessions[0]),
  );

  await new Promise(resolve => setTimeout(resolve, 280));
  finish!();
  await pending;

  assert.equal(snapshots[0].status.kind, "queued");
  assert.ok(snapshots.filter(s => s.status.kind === "running").length >= 2);
  assert.equal(snapshots.at(-1).status.outcome, "completed");
});

test("manager emits live agent progress with the right transitions", async () => {
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project", model: "test/model" }]]),
  };
  let emit: ((e: any) => void) | undefined;
  const session = { messages: [], subscribe(handler: any) { emit = handler; return () => {}; }, prompt: async () => {}, abort: () => {} };
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(session);
    emit!({ type: "message_start" });
    emit!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working through the delegated task" } });
    emit!({ type: "tool_execution_start", toolName: "read" });
    emit!({ type: "turn_end" });
    emit!({ type: "tool_execution_end" });
    return completedRun(agent, "done");
  };
  const manager = new AgentManager(registry as any, 1, runner);
  const snapshots: any[] = [];

  const results = await manager.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "Summarize the project status for the parent agent." }],
    update => snapshots.push(update.sessions[0]),
  );

  assert.equal(results[0].status, "completed");
  assert.ok(snapshots.length >= 4);
  assert.equal(snapshots[0].status.kind, "queued");
  assert.equal(snapshots[0].config.name, "helper");

  assert.ok(snapshots.some(s => s.status.kind === "running"));
  assert.ok(snapshots.some(s => s.activity.toolHistory.some((tool: any) => tool.name === "read" && tool.completedAt === undefined)));
  assert.ok(snapshots.some(s => s.activity.turns === 1));
  assert.ok(snapshots.some(s => s.activity.messageSnippet === "working through the delegated task"));
  assert.equal(snapshots.at(-1).status.outcome, "completed");
});

test("manager throttles live message snippets while lifecycle updates are immediate", async () => {
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  let emit: ((e: any) => void) | undefined;
  const session = { messages: [], subscribe(handler: any) { emit = handler; return () => {}; }, prompt: async () => {}, abort: () => {} };
  let finish: () => void;
  const allowFinish = new Promise<void>(resolve => { finish = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(session);
    emit!({ type: "message_start" });
    emit!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one" } });
    emit!({ type: "message_start" });
    emit!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "two" } });
    emit!({ type: "message_start" });
    emit!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "three" } });
    await allowFinish;
    return completedRun(agent, "done");
  };
  const manager = new AgentManager(registry as any, 1, runner);
  const snapshots: any[] = [];
  const pending = manager.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "work" }],
    update => snapshots.push(update.sessions[0]),
  );

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(snapshots.some(s => s.status.kind === "running"));
  assert.equal(snapshots.filter(s => s.activity.messageSnippet).length, 0);

  await new Promise(resolve => setTimeout(resolve, 130));
  const withMessage = snapshots.filter(s => s.activity.messageSnippet);
  assert.equal(withMessage.length, 1);
  assert.equal(snapshots.at(-1).activity.messageSnippet, "three");

  finish!();
  await pending;
});

test("manager.run handles a mixed batch of one spawn and one resume with resumed flags on both results and rendered AgentViews", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt; agent.attach(session); return completedRun(agent, `spawn:${prompt}`); };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `resume:${prompt}`, true);
  };
  const registry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
      ["fresh", { name: "fresh", description: "d", systemPrompt: "s", source: "project", resumable: true }],
    ]),
  };
  const manager = new AgentManager(registry as any, 2, merge(runner, resumeRunner));

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

test("manager.run resume task targeting an unknown sessionId yields a per-task error and does not block siblings", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt; agent.attach(session); return completedRun(agent, `done:${prompt}`); };
  const registry = {
    agents: new Map([["fresh", { name: "fresh", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const results = await manager.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: "nonexistent", prompt: "ghost" },
    { kind: "spawn", agent: "fresh", prompt: "real" },
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].status, "error");
  assert.equal(results[0].resumed, true);
  assert.match(results[0].error ?? "", /Unknown resumable subagent session: nonexistent/);
  assert.equal(results[1].status, "completed");
  assert.equal(results[1].resumed, false);
  assert.equal(results[1].output, "done:real");
});

test("AgentManager.remove with an unknown sessionId returns the unknown-id error and no removals", async () => {
  const registry = { agents: new Map() };
  const manager = new AgentManager(registry as any, 1, async () => ({ status: "completed" }) as any);

  const result = await manager.remove({ sessionIds: ["unknown"] });

  assert.equal(result.removed, 0);
  assert.equal(result.aborted, 0);
  assert.deepEqual(result.sessionIds, []);
  assert.equal(result.errors!.length, 1);
  assert.equal(result.errors![0].sessionId, "unknown");
  assert.match(result.errors![0].error, /Unknown.*session/i);
});

test("AgentManager.remove scope=non-running removes terminal and queued sessions but leaves running ones", async () => {
  let unblockRunning: () => void;
  const runningGate = new Promise<void>(resolve => { unblockRunning = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    if (prompt === "block") await runningGate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
      ["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }],
    ]),
  };
  const manager = new AgentManager(registry as any, 1, runner);
  await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "retain me" },
  ]);
  const pending = manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "block" },
    { kind: "spawn", agent: "oneshot", prompt: "queued" },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(manager.listSessions().map(s => s.status.kind).sort(), ["done", "queued", "running"]);

  const result = await manager.remove({ scope: "non-running" });

  assert.equal(result.removed, 2);
  assert.equal(result.aborted, 0);
  assert.equal(manager.listSessions().length, 1);
  assert.equal(manager.listSessions()[0].status.kind, "running");

  unblockRunning!();
  await pending;
});

test("AgentManager.remove with a queued sessionId prevents the queued spawn from later invoking the runner", async () => {
  let unblockRunning: () => void;
  const runningGate = new Promise<void>(resolve => { unblockRunning = resolve; });
  const runnerPrompts: string[] = [];
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    runnerPrompts.push(prompt);
    agent.attach(makeSession());
    if (prompt === "block") await runningGate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner);

  const pending = manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "block" },
    { kind: "spawn", agent: "oneshot", prompt: "queued" },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const queued = manager.listSessions().find(s => s.status.kind === "queued");
  assert.ok(queued);

  const result = await manager.remove({ sessionIds: [queued.id] });
  assert.equal(result.removed, 1);
  assert.equal(result.aborted, 0);

  unblockRunning!();
  const results = await pending;

  assert.deepEqual(runnerPrompts, ["block"]);
  assert.equal(results[1].status, "skipped");
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager.remove with a queued resume sessionId prevents the queued resume runner from starting", async () => {
  let unblockRunning: () => void;
  const runningGate = new Promise<void>(resolve => { unblockRunning = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    if (prompt === "block") await runningGate;
    return completedRun(agent, "done");
  };
  let resumeCalls = 0;
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    resumeCalls += 1;
    agent.attach(makeSession());
    return completedRun(agent, "resumed");
  };
  const registry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
      ["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }],
    ]),
  };
  const manager = new AgentManager(registry as any, 1, merge(runner, resumeRunner));
  const [seed] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "seed" },
  ]);

  const pending = manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "block" },
    { kind: "resume", sessionId: seed.sessionId!, prompt: "queued resume" },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));

  const result = await manager.remove({ sessionIds: [seed.sessionId!] });
  assert.equal(result.removed, 1);
  assert.equal(result.aborted, 0);

  unblockRunning!();
  const results = await pending;

  assert.equal(resumeCalls, 0);
  assert.equal(results[1].status, "skipped");
  assert.equal(results[1].resumed, true);
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager.remove on a second pass of the same sessionId returns the unknown-id error", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner);
  const [seed] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "work" },
  ]);

  const firstResult = await manager.remove({ sessionIds: [seed.sessionId!] });
  assert.equal(firstResult.removed, 1);
  assert.deepEqual(firstResult.errors, []);

  const secondResult = await manager.remove({ sessionIds: [seed.sessionId!] });
  assert.equal(secondResult.removed, 0);
  assert.equal(secondResult.errors!.length, 1);
  assert.equal(secondResult.errors![0].sessionId, seed.sessionId);
  assert.match(secondResult.errors![0].error, /Unknown.*session/i);
});

test("AgentManager.remove scope=background is a valid no-op until background dispatch lands", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner);
  await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "one" },
  ]);
  assert.equal(manager.listSessions().length, 1);

  const result = await manager.remove({ scope: "background" });

  assert.deepEqual(result, { removed: 0, aborted: 0, sessionIds: [], errors: [] });
  assert.equal(manager.listSessions().length, 1);
});

test("AgentManager.remove scope=retained removes retained resumable sessions and leaves running and queued alone", async () => {
  let unblockRunning: () => void;
  const runningGate = new Promise<void>(resolve => { unblockRunning = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    if (prompt === "block") await runningGate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
      ["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }],
    ]),
  };
  const manager = new AgentManager(registry as any, 1, runner);

  await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "remember me" },
  ]);
  assert.equal(manager.listSessions().length, 1);

  const pending = manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "block" },
    { kind: "spawn", agent: "oneshot", prompt: "queued" },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(manager.listSessions().map(s => s.status.kind).sort(), ["done", "queued", "running"]);

  const result = await manager.remove({ scope: "retained" });

  assert.equal(result.removed, 1);
  assert.equal(result.aborted, 0);
  assert.equal(result.sessionIds.length, 1);
  assert.deepEqual(manager.listSessions().map(s => s.status.kind).sort(), ["queued", "running"]);

  unblockRunning!();
  await pending;
});

test("AgentManager.remove scope=retained leaves resumable background sessions while removing foreground retained sessions", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, `done:${prompt}`);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const [foreground] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "foreground" },
  ]);
  const bgBatch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "chatty", prompt: "background" }],
    undefined,
    { background: true },
  );
  const [background] = await bgBatch.resultsPromise;

  assert.deepEqual(manager.listSessions().map(s => s.kind).sort(), ["background", "retained"]);

  const result = await manager.remove({ scope: "retained" });

  assert.equal(result.removed, 1);
  assert.deepEqual(result.sessionIds, [foreground.sessionId]);
  const remaining = manager.listSessions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, background.sessionId);
  assert.equal(remaining[0].kind, "background");
});

test("AgentManager.remove with a running sessionId aborts the underlying session and removes it", async () => {
  let abortCalls = 0;
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    let resolveAbort: () => void;
    const aborted = new Promise<void>(resolve => { resolveAbort = resolve; });
    const session = {
      messages: [],
      subscribe: () => () => {},
      prompt: async () => {},
      abort: () => { abortCalls += 1; resolveAbort!(); },
    };
    agent.attach(session);
    await aborted;
    return interruptedRun(agent, "aborted by remove");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const pending = manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "work" },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const runningId = manager.listSessions()[0].id;
  assert.equal(manager.listSessions()[0].status.kind, "running");

  const result = await manager.remove({ sessionIds: [runningId] });
  await pending;

  assert.equal(result.removed, 1);
  assert.equal(result.aborted, 1);
  assert.deepEqual(result.sessionIds, [runningId]);
  assert.equal(abortCalls, 1);
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager.remove rejects an unknown internal scope without removing sessions", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner);
  await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "work" },
  ]);

  await assert.rejects(
    () => manager.remove({ scope: "retianed" as any }),
    /Unknown remove scope: retianed/,
  );
  assert.equal(manager.listSessions().length, 1);
});

test("AgentManager.startBatch returns sessions synchronously and a resultsPromise mirroring run() for background:false", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, `done:${prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const batch = manager.startBatch(
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
  assert.deepEqual(batch.sessions.map(s => s.kind), ["retained", "retained"]);

  const results = await batch.resultsPromise;
  assert.deepEqual(results.map(r => r.status), ["completed", "completed"]);
  assert.deepEqual(results.map(r => r.output), ["done:one", "done:two"]);
});

test("AgentManager.startBatch with background:true returns sessions tagged kind:background and surfaces them in listSessions while running", async () => {
  let releaseRun: () => void;
  const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    await runGate;
    return completedRun(agent, `done:${prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "go" }],
    undefined,
    { background: true },
  );

  assert.equal(batch.sessions.length, 1);
  assert.equal(batch.sessions[0].kind, "background");

  const listed = manager.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "background");

  releaseRun!();
  await batch.resultsPromise;
});

test("AgentManager.startBatch background:true ignores parent signal abort and lets children complete", async () => {
  const seenSignals: Array<AbortSignal | undefined> = [];
  let releaseRun: () => void;
  const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any, signal: AbortSignal | undefined) => { const prompt = attempt.prompt;
    seenSignals.push(signal);
    agent.attach(makeSession());
    await runGate;
    return completedRun(agent, `done:${prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);
  const controller = new AbortController();

  const batch = manager.startBatch(
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

test("AgentManager background non-resumable agents stay listed with terminal status after settlement", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "work" }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;

  const listed = manager.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "background");
  assert.equal(listed[0].status.kind, "done");
  assert.equal(listed[0].status.kind === "done" && listed[0].status.outcome, "completed");
});

test("AgentManager.startBatch background:true promotes resumed sessions to background and remove scope=background selects them", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(session);
    return completedRun(agent, `seed:${prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `resumed:${prompt}`);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 2, merge(runner, resumeRunner));
  const [seed] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial" },
  ]);

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "resume", sessionId: seed.sessionId!, prompt: "follow-up" }],
    undefined,
    { background: true },
  );

  assert.equal(batch.sessions.length, 1);
  assert.equal(batch.sessions[0].id, seed.sessionId);
  assert.equal(batch.sessions[0].kind, "background");

  const [resumed] = await batch.resultsPromise;
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.sessionId, seed.sessionId);

  const listed = manager.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, seed.sessionId);
  assert.equal(listed[0].kind, "background");

  const result = await manager.remove({ scope: "background" });
  assert.equal(result.removed, 1);
  assert.deepEqual(result.sessionIds, [seed.sessionId]);
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager.remove scope=background aborts running background sessions", async () => {
  let unblockRunning: () => void;
  const runningGate = new Promise<void>(resolve => { unblockRunning = resolve; });
  let abortCalls = 0;
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    const session = {
      messages: [] as any[],
      subscribe: () => () => {},
      prompt: async () => {},
      abort: () => { abortCalls += 1; unblockRunning?.(); },
    };
    agent.attach(session);
    await runningGate;
    return interruptedRun(agent, "aborted by remove");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const bgBatch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "long running bg" }],
    undefined,
    { background: true },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(manager.listSessions()[0].status.kind, "running");

  const result = await manager.remove({ scope: "background" });
  await bgBatch.resultsPromise;

  assert.equal(result.removed, 1);
  assert.equal(result.aborted, 1);
  assert.equal(abortCalls, 1);
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager.backgroundResults returns ready:true with the AgentRunResult for a completed background session", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "bg-output");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "go" }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;
  const sessionId = batch.sessions[0].id;

  const results = await manager.backgroundResults([sessionId]);

  assert.equal(results.length, 1);
  const entry = results[0];
  assert.equal(entry.sessionId, sessionId);
  assert.equal((entry as any).ready, true);
  assert.equal((entry as any).result.status, "completed");
  assert.equal((entry as any).result.output, "bg-output");
  assert.equal((entry as any).result.agent, "oneshot");
});

test("AgentManager.backgroundResults returns ready:false running with elapsedMs and agent for a running background session", async () => {
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "longwork", label: "phase 1" }],
    undefined,
    { background: true },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = batch.sessions[0].id;

  const results = await manager.backgroundResults([sessionId]);

  assert.equal(results.length, 1);
  const entry = results[0] as any;
  assert.equal(entry.sessionId, sessionId);
  assert.equal(entry.ready, false);
  assert.equal(entry.status, "running");
  assert.equal(entry.agent, "helper");
  assert.equal(entry.label, "phase 1");
  assert.ok(typeof entry.elapsedMs === "number" && entry.elapsedMs >= 0);

  release!();
  await batch.resultsPromise;
});

test("AgentManager.backgroundResults returns ready:false queued with elapsedMs from createdAt for a queued background session", async () => {
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner);

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [
      { kind: "spawn", agent: "helper", prompt: "first" },
      { kind: "spawn", agent: "helper", prompt: "queued one" },
    ],
    undefined,
    { background: true },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const queuedId = batch.sessions[1].id;

  const results = await manager.backgroundResults([queuedId]);

  assert.equal(results.length, 1);
  const entry = results[0] as any;
  assert.equal(entry.ready, false);
  assert.equal(entry.status, "queued");
  assert.equal(entry.agent, "helper");
  assert.ok(typeof entry.elapsedMs === "number" && entry.elapsedMs >= 0);

  release!();
  await batch.resultsPromise;
});

test("AgentManager.backgroundResults returns a per-id error entry for an unknown sessionId", async () => {
  const registry = { agents: new Map() };
  const manager = new AgentManager(registry as any, 1, async () => ({} as any));

  const results = await manager.backgroundResults(["nope"]);

  assert.equal(results.length, 1);
  const entry = results[0] as any;
  assert.equal(entry.sessionId, "nope");
  assert.equal(entry.error, "Unknown subagent session: nope");
  assert.equal(entry.ready, undefined);
});

test("AgentManager.backgroundResults preserves input order across mixed entries and supports duplicates", async () => {
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    if (prompt === "running") await gate;
    return completedRun(agent, `done:${prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const completedBatch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "completed" }],
    undefined,
    { background: true },
  );
  await completedBatch.resultsPromise;
  const completedId = completedBatch.sessions[0].id;

  const runningBatch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "running" }],
    undefined,
    { background: true },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const runningId = runningBatch.sessions[0].id;

  const results = await manager.backgroundResults([completedId, runningId, "missing", completedId]);

  assert.equal(results.length, 4);
  assert.equal(results[0].sessionId, completedId);
  assert.equal((results[0] as any).ready, true);
  assert.equal(results[1].sessionId, runningId);
  assert.equal((results[1] as any).ready, false);
  assert.equal((results[1] as any).status, "running");
  assert.equal(results[2].sessionId, "missing");
  assert.match((results[2] as any).error, /Unknown subagent session: missing/);
  assert.equal(results[3].sessionId, completedId);
  assert.equal((results[3] as any).ready, true);

  release!();
  await runningBatch.resultsPromise;
});

test("AgentManager.backgroundResults remove:true sweeps terminal entries and a follow-up list omits them", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "go" }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;
  const sessionId = batch.sessions[0].id;
  assert.equal(manager.listSessions().length, 1);

  const first = await manager.backgroundResults([sessionId], { remove: true });
  assert.equal((first[0] as any).ready, true);
  assert.deepEqual(manager.listSessions(), []);

  const second = await manager.backgroundResults([sessionId], { remove: true });
  assert.equal(second.length, 1);
  assert.match((second[0] as any).error, /Unknown subagent session/);
});

test("AgentManager.backgroundResults remove:true returns duplicate terminal results before sweeping", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "go" }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;
  const sessionId = batch.sessions[0].id;

  const results = await manager.backgroundResults([sessionId, sessionId], { remove: true });

  assert.equal(results.length, 2);
  assert.equal(results[0].sessionId, sessionId);
  assert.equal(results[1].sessionId, sessionId);
  assert.equal((results[0] as any).ready, true);
  assert.equal((results[1] as any).ready, true);
  assert.equal((results[0] as any).result.output, "done");
  assert.equal((results[1] as any).result.output, "done");
  assert.deepEqual(manager.listSessions(), []);

  const later = await manager.backgroundResults([sessionId]);
  assert.equal(later.length, 1);
  assert.match((later[0] as any).error, /Unknown subagent session/);
});

test("AgentManager.backgroundResults remove:true does not remove running entries", async () => {
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "long" }],
    undefined,
    { background: true },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = batch.sessions[0].id;

  const results = await manager.backgroundResults([sessionId], { remove: true });
  assert.equal((results[0] as any).ready, false);
  assert.equal((results[0] as any).status, "running");

  const listed = manager.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, sessionId);

  release!();
  await batch.resultsPromise;
});

test("AgentManager.backgroundResults reads retained foreground sessions identically to background ones", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(session);
    return completedRun(agent, "retained-output");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 1, runner);

  // Foreground retained session (not started via startBatch background:true).
  const [seed] = await manager.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial" },
  ]);
  assert.equal(manager.listSessions()[0].kind, "retained");

  const [entry] = await manager.backgroundResults([seed.sessionId!]) as any[];
  assert.equal(entry.ready, true);
  assert.equal(entry.result.output, "retained-output");
  assert.equal(entry.result.resumable, true);
});

test("AgentManager.run forwards parentSessionId to every spawned agent's view and result", async () => {
  const seenParents: Array<string | undefined> = [];
  const runner = async (_ctx: any, agent: any) => {
    seenParents.push(agent.parentSessionId);
    agent.attach(makeSession());
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);

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

const baseAgentConfig = { name: "helper", description: "d", systemPrompt: "s", source: "project" as const, resumable: false };

test("AgentManager.childFactoryFor returns a factory that registers a 'subagent' tool", () => {
  const registry: FakeRegistry = { agents: new Map() };
  const manager = new AgentManager(registry as any);
  const parent = new Agent("parent-1", baseAgentConfig, { kind: "spawn", agent: "helper", prompt: "p" });

  const factory = manager.childFactoryFor(parent, () => DEFAULT_SUBAGENT_SETTINGS);
  const registered: any[] = [];
  factory({ registerTool: (tool: any) => registered.push(tool) } as any);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "subagent");
  assert.equal(typeof registered[0].execute, "function");
});

function captureChildTool(manager: AgentManager, parent: Agent): any {
  let captured: any;
  const factory = manager.childFactoryFor(parent, () => DEFAULT_SUBAGENT_SETTINGS);
  factory({ registerTool: (tool: any) => { captured = tool; } } as any);
  return captured;
}

test("child subagent tool delegates action=run to the shared manager with parentSessionId set", async () => {
  const seenParents: Array<string | undefined> = [];
  const runner = async (_ctx: any, agent: any) => {
    seenParents.push(agent.parentSessionId);
    agent.attach(makeSession());
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);
  const parent = new Agent("parent-7", baseAgentConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  const tool = captureChildTool(manager, parent);

  const result = await tool.execute(
    "call-1",
    { action: "run", tasks: [{ agent: "worker", prompt: "delegate" }] },
    undefined,
    undefined,
    baseCtx(),
  );

  assert.equal(result.isError, false, `unexpected error: ${result.content?.[0]?.text}`);
  assert.deepEqual(seenParents, ["parent-7"]);
});

test("child subagent tool forwards list, results, and remove actions straight to the shared manager", async () => {
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);
  await manager.run(baseCtx(), undefined, [{ kind: "spawn", agent: "worker", prompt: "seed" }]);
  const seeded = manager.listSessions();
  assert.equal(seeded.length, 1);
  const seededId = seeded[0].id;

  const parent = new Agent("parent-7", baseAgentConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  const tool = captureChildTool(manager, parent);

  const list = await tool.execute("c-list", { action: "list" }, undefined, undefined, baseCtx());
  assert.equal(list.isError, false);
  assert.deepEqual(list.details.sessions.map((s: any) => s.id), [seededId]);

  const results = await tool.execute("c-results", { action: "results", sessionIds: [seededId] }, undefined, undefined, baseCtx());
  assert.equal(results.isError, false);
  assert.equal(results.details.results[0].sessionId, seededId);

  const removed = await tool.execute("c-remove", { action: "remove", sessionIds: [seededId] }, undefined, undefined, baseCtx());
  assert.equal(removed.isError, false);
  assert.equal(removed.details.summary.removed, 1);
  assert.deepEqual(manager.listSessions(), []);
});

test("recursive foreground subagent spawn completes with a single shared queue slot", async () => {
  const runner = async (ctx: any, agent: any) => {
    agent.attach(makeSession());
    if (agent.spawn.prompt === "spawn-child") {
      const factory = manager.childFactoryFor(agent);
      let tool: any;
      factory({ registerTool: (t: any) => { tool = t; } } as any);
      const result = await tool.execute(
        "child-call",
        { action: "run", tasks: [{ agent: "worker", prompt: "leaf" }] },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, false);
      return completedRun(agent, "parent-done");
    }
    return completedRun(agent, "leaf-done");
  };

  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager: AgentManager = new AgentManager(registry as any, 1, runner);

  const results = await Promise.race([
    manager.run(baseCtx(), undefined, [{ kind: "spawn", agent: "worker", prompt: "spawn-child" }]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("recursive run timed out")), 100)),
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(manager.listSessions().length, 2);
});

test("recursive foreground subagent chain can exceed the shared queue cap without deadlocking", async () => {
  const runner = async (ctx: any, agent: any) => {
    agent.attach(makeSession());
    if (agent.spawn.prompt.startsWith("spawn-")) {
      const remaining = Number(agent.spawn.prompt.slice("spawn-".length));
      const factory = manager.childFactoryFor(agent);
      let tool: any;
      factory({ registerTool: (t: any) => { tool = t; } } as any);
      const result = await tool.execute(
        `child-${remaining}`,
        { action: "run", tasks: [{ agent: "worker", prompt: remaining > 1 ? `spawn-${remaining - 1}` : "leaf" }] },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, false);
    }
    return completedRun(agent, `done:${agent.spawn.prompt}`);
  };

  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager: AgentManager = new AgentManager(registry as any, 1, runner);

  const results = await Promise.race([
    manager.run(baseCtx(), undefined, [{ kind: "spawn", agent: "worker", prompt: "spawn-3" }]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("recursive chain timed out")), 100)),
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(manager.listSessions().length, 4);
});

test("recursive subagent spawn: root → child → grandchild all live under one shared manager with correct parent links", async () => {
  // Custom runner that simulates each Agent's behavior: depending on the prompt, the agent either
  // spawns its own subagent via the child-session factory tool, or returns directly. This exercises
  // the full child-factory flow without standing up a real Pi session.
  const recordedParents: Record<string, string | undefined> = {};
  const runner = async (ctx: any, agent: any) => {
    recordedParents[agent.id] = agent.parentSessionId;
    agent.attach(makeSession());
    if (agent.spawn.prompt === "spawn-child") {
      const factory = manager.childFactoryFor(agent);
      let tool: any;
      factory({ registerTool: (t: any) => { tool = t; } } as any);
      const result = await tool.execute(
        "c-call",
        { action: "run", tasks: [{ agent: "worker", prompt: "spawn-grandchild" }] },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, false);
      return completedRun(agent, "child-done");
    }
    if (agent.spawn.prompt === "spawn-grandchild") {
      const factory = manager.childFactoryFor(agent);
      let tool: any;
      factory({ registerTool: (t: any) => { tool = t; } } as any);
      const result = await tool.execute(
        "g-call",
        { action: "run", tasks: [{ agent: "worker", prompt: "leaf" }] },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.isError, false);
      return completedRun(agent, "grandchild-done");
    }
    return completedRun(agent, "leaf-done");
  };

  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager: AgentManager = new AgentManager(registry as any, 8, runner);

  const results = await manager.run(baseCtx(), undefined, [{ kind: "spawn", agent: "worker", prompt: "spawn-child" }]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], "parentSessionId"), false, "root result has no parent");

  // Three distinct ids should have been seen by the runner — root, child, grandchild.
  const ids = Object.keys(recordedParents);
  assert.equal(ids.length, 3, `expected 3 agent runs, got ${ids.length}`);

  const rootIds = ids.filter(id => recordedParents[id] === undefined);
  assert.equal(rootIds.length, 1);
  const rootId = rootIds[0];

  const childIds = ids.filter(id => recordedParents[id] === rootId);
  assert.equal(childIds.length, 1, "exactly one child should point to root");
  const childId = childIds[0];

  const grandchildIds = ids.filter(id => recordedParents[id] === childId);
  assert.equal(grandchildIds.length, 1, "exactly one grandchild should point to child");
  const grandchildId = grandchildIds[0];

  // All three retained sessions visible from the root manager with the expected linkage.
  const sessions = manager.listSessions();
  assert.equal(sessions.length, 3);
  const sessionsById = new Map(sessions.map(s => [s.id, s]));
  assert.equal(sessionsById.get(rootId)?.parentSessionId, undefined);
  assert.equal(sessionsById.get(childId)?.parentSessionId, rootId);
  assert.equal(sessionsById.get(grandchildId)?.parentSessionId, childId);
});

test("child subagent tool does not reload settings or rebuild the registry on each call", async () => {
  let settingsCalls = 0;
  let registryReloads = 0;
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project" }]]),
    reload: async () => { registryReloads += 1; },
    summarizeAgent: () => "worker",
  };
  const manager = new AgentManager(registry as any, 2, async (_c: any, a: any) => { a.attach(makeSession()); return completedRun(a, "ok"); });
  const parent = new Agent("parent-7", baseAgentConfig, { kind: "spawn", agent: "helper", prompt: "p" });

  const factory = manager.childFactoryFor(parent, () => { settingsCalls += 1; return DEFAULT_SUBAGENT_SETTINGS; });
  let captured: any;
  factory({ registerTool: (t: any) => { captured = t; } } as any);

  await captured.execute("c1", { action: "list" }, undefined, undefined, baseCtx());
  await captured.execute("c2", { action: "agents" }, undefined, undefined, baseCtx());

  assert.equal(registryReloads, 0, "child invocations must not reload the registry");
  assert.ok(settingsCalls >= 1, "child invocations should read current settings");
});

test("AgentManager.startBatch threads parentSessionId into views surfaced through listSessions", async () => {
  let releaseFirst!: () => void;
  const blocker = new Promise<void>(resolve => { releaseFirst = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await blocker;
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = new AgentManager(registry as any, 2, runner);
  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "go" }],
    undefined,
    { background: false, parentSessionId: "parent-7" },
  );

  await new Promise(resolve => setTimeout(resolve, 10));
  const sessions = manager.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].parentSessionId, "parent-7");

  releaseFirst();
  await batch.resultsPromise;
});

// Suppress unused-variable warnings for shared types.
void undefined as unknown as AnyManager;
