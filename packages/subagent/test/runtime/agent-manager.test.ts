import { test } from "vitest";
import assert from "node:assert/strict";

import { completedRun, interruptedRun } from "../../src/domain/agent-result.js";
import { baseCtx, makeManagerAndOrchestrator, makeSession, mergeRunners } from "../helpers/runtime.js";

test("AgentManager.listSessions returns all retained sessions when called with no filter", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(session);
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["good", { name: "good", description: "", systemPrompt: "", source: "project", resumable: true, tools: [] }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);
  await orchestrator.run(baseCtx(), undefined, [{ kind: "spawn", agent: "good", prompt: "go" }]);

  const all = manager.listSessions();
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "retained");
});

test("AgentManager does not expose skipped resumable tasks as sessions", async () => {
  let finishFirst: () => void;
  const firstCanFinish = new Promise<void>(resolve => { finishFirst = resolve; });
  const runner = async (_ctx: any, agent: any) => {
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
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);
  const controller = new AbortController();

  const pending = orchestrator.run(baseCtx(), controller.signal, [
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

test("AgentManager does not expose or resume non-resumable completed sessions", async () => {
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);

  const results = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], "sessionId"), false);
  assert.deepEqual(manager.listSessions(), []);
  const [retried] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: "anything", prompt: "follow up" },
  ]);
  assert.equal(retried.status, "error");
  assert.equal(retried.resumed, true);
  assert.match(retried.error ?? "", /Unknown resumable subagent session/);
});

test("AgentManager discards a completed session when a task overrides resumable to false at spawn or resume", async () => {
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
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, mergeRunners(runner, resumeRunner));

  // Spawn-side override: session is never retained.
  const spawnResults = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "spawn-only", resumable: false },
  ]);
  assert.equal(spawnResults[0].status, "completed");
  assert.equal(spawnResults[0].resumable, false);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnResults[0], "sessionId"), false);
  assert.deepEqual(manager.listSessions(), []);

  // Resume-side override: session retained on initial spawn, then discarded on resume.
  const [seed] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial" },
  ]);
  assert.equal(manager.listSessions().length, 1);
  const [resumed] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: seed.sessionId!, prompt: "tear down", resumable: false },
  ]);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.resumable, false);
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager retains only resumable interrupted sessions, clearing only after parent cancellation settles", async () => {
  const runner = async (_ctx: any, agent: any, _attempt: any, signal: AbortSignal) => {
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
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner as any);
  const controller = new AbortController();

  const pending = orchestrator.run(baseCtx(), controller.signal, [
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

  const [retried] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: results[1].sessionId!, prompt: "follow up" },
  ]);
  assert.equal(retried.status, "error");
  assert.equal(retried.resumed, true);
  assert.match(retried.error ?? "", /while it is interrupted/);
  assert.deepEqual(await manager.remove({ sessionIds: [results[1].sessionId!] }), { removed: 1, aborted: 0, sessionIds: [results[1].sessionId!], errors: [] });
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager retains a completed session when a task overrides resumable to true", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(session);
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `follow:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, mergeRunners(runner, resumeRunner));

  const results = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work", resumable: true },
  ]);

  assert.equal(results[0].resumable, true);
  assert.ok(results[0].sessionId);
  assert.deepEqual(
    manager.listSessions().map(s => [s.id, s.config.name, s.config.resumable]),
    [[results[0].sessionId, "oneshot", true]],
  );

  const [resumed] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: results[0].sessionId!, prompt: "again" },
  ]);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, "follow:again");
});

test("AgentManager.backgroundResults reports queued resume elapsed from the current attempt time", async () => {
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
    const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, mergeRunners(runner, resumeRunner));

    const [initial] = await orchestrator.run(baseCtx(), undefined, [
      { kind: "spawn", agent: "chatty", prompt: "old" },
    ]);
    assert.ok(initial.sessionId);

    now = 100_000;
    const batch = orchestrator.startBatch(baseCtx(), undefined, [
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

test("AgentManager retains, resumes, lists, and clears completed resumable sessions", async () => {
  let runEmit: ((event: any) => void) | undefined;
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    const session = {
      messages: [],
      subscribe(handler: any) { runEmit = handler; return () => { runEmit = undefined; }; },
      prompt: async () => {},
      abort: () => {},
    };
    agent.attach(session);
    runEmit!({ type: "turn_end" });
    return completedRun(agent, `response:${attempt.prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(agent.retainedSession()!);
    runEmit!({ type: "turn_end" });
    return completedRun(agent, `follow:${attempt.prompt}`);
  };

  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, mergeRunners(runner, resumeRunner));
  const results = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "one" },
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(results[0].output, "response:one");
  assert.ok(results[0].sessionId);
  assert.deepEqual(manager.listSessions().map(s => s.id), [results[0].sessionId]);

  const [resumed] = await orchestrator.run(baseCtx(), undefined, [
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

test("AgentManager.remove with an unknown sessionId returns the unknown-id error and no removals", async () => {
  const registry = { agents: new Map() };
  const { manager } = makeManagerAndOrchestrator(registry as any, 1, async () => ({ status: "completed" }) as any);

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
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    if (attempt.prompt === "block") await runningGate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
      ["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }],
    ]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);
  await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "retain me" },
  ]);
  const pending = orchestrator.run(baseCtx(), undefined, [
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
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    runnerPrompts.push(attempt.prompt);
    agent.attach(makeSession());
    if (attempt.prompt === "block") await runningGate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);

  const pending = orchestrator.run(baseCtx(), undefined, [
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
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    if (attempt.prompt === "block") await runningGate;
    return completedRun(agent, "done");
  };
  let resumeCalls = 0;
  const resumeRunner = async (_ctx: any, agent: any) => {
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
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, mergeRunners(runner, resumeRunner));
  const [seed] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "seed" },
  ]);

  const pending = orchestrator.run(baseCtx(), undefined, [
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
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);
  const [seed] = await orchestrator.run(baseCtx(), undefined, [
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

test("AgentManager.remove scope=retained removes retained resumable sessions and leaves running and queued alone", async () => {
  let unblockRunning: () => void;
  const runningGate = new Promise<void>(resolve => { unblockRunning = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    if (attempt.prompt === "block") await runningGate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
      ["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }],
    ]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);

  await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "remember me" },
  ]);
  assert.equal(manager.listSessions().length, 1);

  const pending = orchestrator.run(baseCtx(), undefined, [
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
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const [foreground] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "foreground" },
  ]);
  const bgBatch = orchestrator.startBatch(
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
  const runner = async (_ctx: any, agent: any) => {
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
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const pending = orchestrator.run(baseCtx(), undefined, [
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
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);
  await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "work" },
  ]);

  await assert.rejects(
    () => manager.remove({ scope: "retianed" as any }),
    /Unknown remove scope: retianed/,
  );
  assert.equal(manager.listSessions().length, 1);
});

test("AgentManager background non-resumable agents stay listed with terminal status after settlement", async () => {
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const batch = orchestrator.startBatch(
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

test("AgentManager.remove scope=background aborts running background sessions", async () => {
  let unblockRunning: (() => void) | undefined;
  const runningGate = new Promise<void>(resolve => { unblockRunning = resolve; });
  let abortCalls = 0;
  const runner = async (_ctx: any, agent: any) => {
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
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const bgBatch = orchestrator.startBatch(
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
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "bg-output");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const batch = orchestrator.startBatch(
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
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const batch = orchestrator.startBatch(
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
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);

  const batch = orchestrator.startBatch(
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
  const { manager } = makeManagerAndOrchestrator(registry as any, 1, async () => ({} as any));

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
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    if (attempt.prompt === "running") await gate;
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const completedBatch = orchestrator.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "completed" }],
    undefined,
    { background: true },
  );
  await completedBatch.resultsPromise;
  const completedId = completedBatch.sessions[0].id;

  const runningBatch = orchestrator.startBatch(
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
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const batch = orchestrator.startBatch(
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
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const batch = orchestrator.startBatch(
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
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const batch = orchestrator.startBatch(
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
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(session);
    return completedRun(agent, "retained-output");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);

  // Foreground retained session (not started via startBatch background:true).
  const [seed] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial" },
  ]);
  assert.equal(manager.listSessions()[0].kind, "retained");

  const [entry] = await manager.backgroundResults([seed.sessionId!]) as any[];
  assert.equal(entry.ready, true);
  assert.equal(entry.result.output, "retained-output");
  assert.equal(entry.result.resumable, true);
});

test("AgentManager.abortDescendantsOf aborts direct children of the given parent id", async () => {
  const aborts: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    let resolveAbort: () => void;
    const aborted = new Promise<void>(resolve => { resolveAbort = resolve; });
    const session = {
      messages: [],
      subscribe: () => () => {},
      prompt: async () => {},
      abort: () => { aborts.push(agent.spawn.prompt); resolveAbort!(); },
    };
    agent.attach(session);
    await aborted;
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 4, runner);

  const batch = orchestrator.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined,
    { background: false, parentSessionId: "parent-1" },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const childId = manager.listSessions()[0].id;
  assert.equal(manager.listSessions()[0].status.kind, "running");

  await manager.abortDescendantsOf("parent-1");
  await batch.resultsPromise;

  assert.deepEqual(aborts, ["child"]);
  const finalChild = manager.listSessions().find(s => s.id === childId);
  assert.equal(finalChild?.status.kind, "done");
});

test("AgentManager.abortDescendantsOf walks grandchildren first (post-order)", async () => {
  const abortOrder: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    let resolveAbort: () => void;
    const aborted = new Promise<void>(resolve => { resolveAbort = resolve; });
    const session = {
      messages: [],
      subscribe: () => () => {},
      prompt: async () => {},
      abort: () => { abortOrder.push(agent.spawn.prompt); resolveAbort!(); },
    };
    agent.attach(session);
    await aborted;
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 4, runner);

  // Manually build a 2-level tree under fake root id "root":
  //   root → child → grandchild
  const childBatch = orchestrator.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined,
    { background: false, parentSessionId: "root" },
  );
  await new Promise(resolve => setTimeout(resolve, 10));
  const childId = manager.listSessions().find(s => s.parentSessionId === "root")!.id;
  const grandBatch = orchestrator.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "grandchild" }],
    undefined,
    { background: false, parentSessionId: childId },
  );
  await new Promise(resolve => setTimeout(resolve, 10));

  await manager.abortDescendantsOf("root");
  await Promise.all([childBatch.resultsPromise, grandBatch.resultsPromise]);

  // Post-order: grandchild's session.abort() must run before child's.
  assert.deepEqual(abortOrder, ["grandchild", "child"]);
});

test("AgentManager.abortDescendantsOf is a no-op when the id has no descendants", async () => {
  const registry = { agents: new Map() };
  const { manager } = makeManagerAndOrchestrator(registry as any, 4, async () => ({ status: "completed" }) as any);

  await manager.abortDescendantsOf("nonexistent-id");
  await manager.abortDescendantsOf("");
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager.abortDescendantsOf skips already-terminal descendants without re-aborting them", async () => {
  const abortCalls: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    agent.attach({
      messages: [],
      subscribe: () => () => {},
      prompt: async () => {},
      abort: () => { abortCalls.push(agent.spawn.prompt); },
    });
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 4, runner);

  // Run a child under parent-1 to completion (becomes terminal "done").
  await orchestrator.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "completed-child" }],
    undefined,
    { parentSessionId: "parent-1" },
  );
  assert.equal(manager.listSessions().length, 1);
  assert.equal(manager.listSessions()[0].status.kind, "done");

  await manager.abortDescendantsOf("parent-1");
  assert.deepEqual(abortCalls, [], "should not call abort() on already-terminal children");
  // Final status snapshot unchanged.
  const view = manager.listSessions()[0];
  assert.equal(view.status.kind, "done");
  assert.equal((view.status as any).outcome, "completed");
});

test("AgentManager.remove fans out abort across a 2-level subagent tree via Agent.abort observer", async () => {
  const aborts: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    // Polling instead of microtask gate models production timing: session.abort() signals an
    // abort flag, but the runner doesn't resume until a later macrotask — so Agent.abort()'s
    // own settle("aborted") runs first.
    const flag = { aborted: false };
    agent.attach({
      messages: [],
      subscribe: () => () => {},
      prompt: async () => {},
      abort: () => { aborts.push(agent.spawn.prompt); flag.aborted = true; },
    });
    while (!flag.aborted) await new Promise(r => setTimeout(r, 5));
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 4, runner);

  const rootBatch = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "root" }],
    undefined, { background: false },
  );
  await new Promise(r => setTimeout(r, 10));
  const rootId = manager.listSessions().find(s => s.parentSessionId === undefined)!.id;

  const childBatch = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined, { background: false, parentSessionId: rootId },
  );
  await new Promise(r => setTimeout(r, 10));
  const childId = manager.listSessions().find(s => s.parentSessionId === rootId)!.id;

  const grandBatch = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "grandchild" }],
    undefined, { background: false, parentSessionId: childId },
  );
  await new Promise(r => setTimeout(r, 10));
  assert.equal(manager.listSessions().filter(s => s.status.kind === "running").length, 3);

  const removeResult = await manager.remove({ sessionIds: [rootId] });
  await Promise.all([rootBatch.resultsPromise, childBatch.resultsPromise, grandBatch.resultsPromise]);

  assert.equal(removeResult.removed, 1);
  assert.deepEqual(aborts.sort(), ["child", "grandchild", "root"]);
  const final = manager.listSessions();
  assert.equal(
    final.filter(s => s.status.kind === "running" || s.status.kind === "queued").length,
    0,
    "no running or queued sessions should remain after fan-out",
  );
  const childView = final.find(s => s.id === childId);
  const grandView = final.find(s => s.parentSessionId === childId);
  assert.equal((childView?.status as any).outcome, "aborted", "child finalizes as aborted");
  assert.equal((grandView?.status as any).outcome, "aborted", "grandchild finalizes as aborted");
});

test("AgentManager.cancelNonBackgroundDescendantsOf cancels a running non-background descendant", async () => {
  const aborts: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    const flag = { aborted: false };
    agent.attach({
      messages: [],
      subscribe: () => () => {},
      prompt: async () => {},
      abort: () => { aborts.push(agent.spawn.prompt); flag.aborted = true; },
    });
    while (!flag.aborted) await new Promise(r => setTimeout(r, 5));
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 4, runner);

  const batch = orchestrator.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined,
    { background: false, parentSessionId: "parent-1" },
  );
  await new Promise(r => setTimeout(r, 20));
  assert.equal(manager.listSessions()[0].status.kind, "running");

  await manager.cancelNonBackgroundDescendantsOf("parent-1", "Parent parent-1 finalized as error");
  await batch.resultsPromise;

  assert.deepEqual(aborts, ["child"]);
  const final = manager.listSessions()[0];
  assert.equal(final.status.kind, "done");
});

test("AgentManager.cancelNonBackgroundDescendantsOf skips background descendants", async () => {
  const aborts: string[] = [];
  const sessions: Record<string, { resolve: () => void; promise: Promise<void> }> = {};
  const runner = async (_ctx: any, agent: any) => {
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    sessions[agent.spawn.prompt] = { resolve, promise: done };
    agent.attach({
      messages: [],
      subscribe: () => () => {},
      prompt: async () => {},
      abort: () => { aborts.push(agent.spawn.prompt); resolve(); },
    });
    await done;
    return interruptedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 4, runner);

  const fgBatch = orchestrator.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "fg" }],
    undefined,
    { background: false, parentSessionId: "parent-1" },
  );
  const bgBatch = orchestrator.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "bg" }],
    undefined,
    { background: true, parentSessionId: "parent-1" },
  );
  await new Promise(r => setTimeout(r, 20));

  await manager.cancelNonBackgroundDescendantsOf("parent-1", "Parent parent-1 finalized as error");

  // Only the non-background child should have been aborted.
  assert.deepEqual(aborts, ["fg"]);

  // Background child still running — clean up by resolving its session.
  sessions["bg"].resolve();
  await Promise.all([fgBatch.resultsPromise, bgBatch.resultsPromise]);
});

test("AgentManager.cancelNonBackgroundDescendantsOf stamps cancelled descendants with the reason", async () => {
  const runner = async (_ctx: any, agent: any) => {
    const flag = { aborted: false };
    agent.attach({
      messages: [],
      subscribe: () => () => {},
      prompt: async () => {},
      abort: () => { flag.aborted = true; },
    });
    while (!flag.aborted) await new Promise(r => setTimeout(r, 5));
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 4, runner);

  const batch = orchestrator.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined,
    { background: false, parentSessionId: "parent-9" },
  );
  await new Promise(r => setTimeout(r, 20));

  await manager.cancelNonBackgroundDescendantsOf("parent-9", "Parent parent-9 finalized as error");
  const [result] = await batch.resultsPromise;

  assert.equal(result.status, "aborted");
  assert.match(result.error ?? "", /parent-9/);
  assert.match(result.error ?? "", /error/);
});

test("AgentManager.subtreeOf returns just the root when the root has no descendants", async () => {
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await blocker;
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);
  const batch = orchestrator.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "root" }],
    undefined,
    { background: false },
  );

  await new Promise(resolve => setTimeout(resolve, 10));
  const rootId = manager.listSessions()[0].id;
  const subtree = manager.subtreeOf([rootId]);

  assert.equal(subtree.length, 1);
  assert.equal(subtree[0].id, rootId);

  release();
  await batch.resultsPromise;
});

test("AgentManager.subtreeOf walks a root → child → grandchild chain", async () => {
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await blocker;
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 4, runner);

  const rootBatch = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "root" }],
    undefined, { background: false },
  );
  await new Promise(r => setTimeout(r, 10));
  const rootId = manager.listSessions()[0].id;
  const childBatch = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined, { background: false, parentSessionId: rootId },
  );
  await new Promise(r => setTimeout(r, 10));
  const childId = manager.listSessions().find(s => s.parentSessionId === rootId)!.id;
  const grandBatch = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "grand" }],
    undefined, { background: false, parentSessionId: childId },
  );
  await new Promise(r => setTimeout(r, 10));

  const subtree = manager.subtreeOf([rootId]);
  assert.deepEqual(
    subtree.map(s => ({ id: s.id, parent: s.parentSessionId })),
    [
      { id: rootId, parent: undefined },
      { id: childId, parent: rootId },
      { id: manager.listSessions().find(s => s.parentSessionId === childId)!.id, parent: childId },
    ],
  );

  release();
  await Promise.all([rootBatch.resultsPromise, childBatch.resultsPromise, grandBatch.resultsPromise]);
});

test("AgentManager.subtreeOf orders siblings by createdAt and roots by input order", async () => {
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await blocker;
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 8, runner);

  // Two roots; the second one starts first so we can later assert input order wins over createdAt.
  const rootB = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "rootB" }],
    undefined, { background: false },
  );
  await new Promise(r => setTimeout(r, 5));
  const rootA = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "rootA" }],
    undefined, { background: false },
  );
  await new Promise(r => setTimeout(r, 5));
  const allRoots = manager.listSessions().filter(s => s.parentSessionId === undefined);
  // rootB was created first, rootA second.
  assert.equal(allRoots.length, 2);
  const rootBActualId = allRoots[0].id;
  const rootAActualId = allRoots[1].id;

  // Under rootA, add two children — the SECOND one created should sort after the first.
  const childA1 = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child-a1" }],
    undefined, { background: false, parentSessionId: rootAActualId },
  );
  await new Promise(r => setTimeout(r, 5));
  const childA2 = orchestrator.startBatch(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child-a2" }],
    undefined, { background: false, parentSessionId: rootAActualId },
  );
  await new Promise(r => setTimeout(r, 5));

  const childAIds = manager.listSessions()
    .filter(s => s.parentSessionId === rootAActualId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(s => s.id);

  // Caller passes rootA first, even though rootB was created earlier.
  const subtree = manager.subtreeOf([rootAActualId, rootBActualId]);
  assert.deepEqual(subtree.map(s => s.id), [rootAActualId, ...childAIds, rootBActualId]);

  release();
  await Promise.all([rootB.resultsPromise, rootA.resultsPromise, childA1.resultsPromise, childA2.resultsPromise]);
});

test("AgentManager.subtreeOf returns an empty list when the requested root id is unknown", async () => {
  const registry = { agents: new Map() };
  const { manager } = makeManagerAndOrchestrator(registry as any, 4, async () => ({ status: "completed" }) as any);
  assert.deepEqual(manager.subtreeOf(["never-existed"]), []);
});
