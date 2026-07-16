import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../../src/domain/agent.js";
import { completedRun, errorRun, interruptedRun } from "../../src/domain/agent-finalize.js";
import { toResult, toResults } from "../../src/domain/agent-result.js";
import { baseCtx, makeManager, makeSession, mergeRunners, run } from "../helpers/runtime.js";

/** Build each physically possible lifecycle/state combination for the catalog policy matrix. */
function matrixAgent(status: "queued" | "running" | "completed" | "error", background: boolean, state: "enabled" | "disabled" | "retained", id: string): Agent {
  const agent = new Agent(
    id,
    { name: "matrix", description: "", systemPrompt: "", source: "project", resumable: state !== "disabled" },
    { kind: "spawn", agent: "matrix", prompt: id },
    () => {},
    { background },
  );
  const session = makeSession() as any;

  if (state === "retained" || status === "running") agent.attach(session);
  if (status === "queued") {
    if (state === "retained") {
      completedRun(agent, "seed");
      agent.beginResume("queued", undefined, background);
    }
  } else if (status === "completed") {
    completedRun(agent, "done");
  } else if (status === "error") {
    errorRun(agent, "failed");
  }
  return agent;
}

test("catalog retention matrix preserves inventory and post-run cleanup behavior", async () => {
  const statuses = ["queued", "running", "completed", "error"] as const;
  const dispatches = [false, true] as const;
  const states = ["enabled", "disabled", "retained"] as const;

  for (const status of statuses) {
    for (const background of dispatches) {
      for (const state of states) {
        const agent = matrixAgent(status, background, state, `${status}-${background}-${state}`);
        const manager = makeManager({ agents: new Map() } as any);
        // Inject a prepared lifecycle row so all matrix arms can exercise public inventory
        // without adding a second production construction path.
        (manager as any)._agents = [agent];

        const active = status === "queued" || status === "running";
        const persistent = background || state !== "disabled" && (active || state === "retained");
        const expectedListed = active || persistent;
        assert.equal(agent.catalogRetention.shouldRemainCataloged, expectedListed, `${status}/${background}/${state}`);
        assert.equal(agent.snapshot().retention, persistent ? "persistent" : "transient", `${status}/${background}/${state} retention`);
        assert.equal(manager.listSessions().length, expectedListed ? 1 : 0, `${status}/${background}/${state} list`);

        if (!active) {
          // Exercise the real post-run cleanup path for every terminal matrix arm as well as the
          // direct owner projection above.
          const cleanupManager = makeManager({
            agents: new Map([[
              "matrix",
              { name: "matrix", description: "", systemPrompt: "", source: "project", resumable: state !== "disabled" },
            ]]),
          } as any, 1, async (_ctx: any, cleanupAgent: any) => {
            if (state === "retained") cleanupAgent.attach(makeSession());
            return status === "completed"
              ? completedRun(cleanupAgent, "done")
              : errorRun(cleanupAgent, "failed");
          });
          const cleanupBatch = cleanupManager.startRun(
            baseCtx(),
            undefined,
            [{ kind: "spawn", agent: "matrix", prompt: "terminal" }],
            undefined,
            { background },
          );
          await cleanupBatch.resultsPromise;
          assert.equal(cleanupManager.listSessions().length, expectedListed ? 1 : 0, `${status}/${background}/${state} cleanup`);
        }
      }
    }
  }
});

test("AgentManager allocates readable unique IDs and does not reuse removed IDs", async () => {
  const config = { name: "worker", description: "", systemPrompt: "", source: "project", resumable: true };
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const manager = makeManager({ agents: new Map([["worker", config]]) } as any, 3, runner);

  const firstBatch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "worker", prompt: "one" },
    { kind: "spawn", agent: "worker", prompt: "two" },
    { kind: "spawn", agent: "worker", prompt: "three" },
  ], undefined, { background: false });
  const firstIds = firstBatch.sessions.map(session => session.id);
  await firstBatch.resultsPromise;

  assert.equal(new Set(firstIds).size, firstIds.length);
  for (const id of firstIds) assert.match(id, /^[a-z]+-[a-z]+$/);

  const removedId = firstIds[0];
  assert.deepEqual(await manager.remove({ sessionIds: [removedId] }), {
    removed: 1,
    aborted: 0,
    sessionIds: [removedId],
    errors: [],
  });

  const replacementBatch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "worker", prompt: "replacement" },
  ], undefined, { background: false });
  const replacementId = replacementBatch.sessions[0].id;
  await replacementBatch.resultsPromise;

  assert.match(replacementId, /^[a-z]+-[a-z]+$/);
  assert.equal(firstIds.includes(replacementId), false);
});

test("manager inventory and raw results omit top-level resumed while retaining terminal status.resumed", async () => {
  const config = { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true };
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(attempt.kind === "resume" ? agent.retainedSession()! : makeSession());
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const manager = makeManager({ agents: new Map([["chatty", config]]) } as any, 1, runner);

  const firstBatch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "first" },
  ], undefined, { background: false });
  assert.equal(firstBatch.sessions[0].resumed, false);
  const [firstSnapshot] = await firstBatch.resultsPromise;
  assert.equal(Object.prototype.hasOwnProperty.call(firstSnapshot, "resumed"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(manager.listSessions()[0], "resumed"), false);

  const resumeBatch = manager.startRun(baseCtx(), undefined, [
    { kind: "resume", sessionId: firstSnapshot.id, prompt: "follow-up" },
  ], undefined, { background: false });
  assert.equal(resumeBatch.sessions[0].resumed, true);
  const [resumeSnapshot] = await resumeBatch.resultsPromise;
  assert.equal(Object.prototype.hasOwnProperty.call(resumeSnapshot, "resumed"), false);
  assert.equal(resumeSnapshot.status.kind, "done");
  assert.equal(resumeSnapshot.status.kind === "done" && resumeSnapshot.status.resumed, true);
  assert.equal(Object.prototype.hasOwnProperty.call(manager.listSessions()[0], "resumed"), false);
});

test("AgentManager.listSessions returns all retained sessions when called with no filter", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(session);
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["good", { name: "good", description: "", systemPrompt: "", source: "project", resumable: true, tools: [] }]]),
  };
  const manager = makeManager(registry as any, 1, runner);
  await run(manager, baseCtx(), undefined, [{ kind: "spawn", agent: "good", prompt: "go" }]);

  const all = manager.listSessions();
  assert.equal(all.length, 1);
  assert.equal(all[0].dispatch, "foreground");
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
  const manager = makeManager(registry as any, 1, runner);
  const controller = new AbortController();

  const pending = run(manager, baseCtx(), controller.signal, [
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
});

test("attaching to a transient running session pins it for retention", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 1, runner);
  const batch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ], undefined, { background: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = manager.listSessions()[0].id;

  assert.equal(manager.listSessions()[0].retention, "transient");
  assert.equal(manager.attachToSession(sessionId).id, sessionId);
  assert.equal(manager.listSessions()[0].retention, "persistent");
  assert.equal(manager.listSessions()[0].config.resumable, true);

  release();
  await batch.resultsPromise;
});

test("an attached non-resumable session remains cataloged and resumable after completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 1, runner);
  const batch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ], undefined, { background: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = manager.listSessions()[0].id;
  manager.attachToSession(sessionId);

  release();
  await batch.resultsPromise;

  assert.equal(manager.listSessions()[0].id, sessionId);
  assert.equal(manager.listSessions()[0].capabilities.canResume, true);
  assert.deepEqual(manager.listAttachedSessions().map(session => session.id), [sessionId]);
});

test("an attached originally non-resumable session can run a tracked resume", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `resumed:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 1, mergeRunners(runner, resumeRunner));
  const batch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ], undefined, { background: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = manager.listSessions()[0].id;
  manager.attachToSession(sessionId);
  release();
  await batch.resultsPromise;

  const [resumed] = await run(manager, baseCtx(), undefined, [
    { kind: "resume", sessionId, prompt: "follow up" },
  ]);

  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, "resumed:follow up");
});

test("detaching a terminal attachment-only session removes its retention pin and prunes it", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 1, runner);
  const batch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ], undefined, { background: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = manager.listSessions()[0].id;
  manager.attachToSession(sessionId);
  release();
  await batch.resultsPromise;

  assert.equal(manager.detachFromSession(sessionId), true);
  assert.deepEqual(manager.listAttachedSessions(), []);
  assert.deepEqual(manager.listSessions(), []);
});

test("detaching does not release a session retained by its original resumable policy", async () => {
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 1, runner);
  const [result] = await run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "work" },
  ]);
  manager.attachToSession(result.sessionId!);

  manager.detachFromSession(result.sessionId!);

  assert.deepEqual(manager.listAttachedSessions(), []);
  assert.equal(manager.listSessions()[0].id, result.sessionId);
  assert.equal(manager.listSessions()[0].capabilities.canResume, true);
});

test("steering an attached running session delegates to its real AgentSession", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const steered: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    agent.attach({
      ...makeSession(),
      async steer(text: string) { steered.push(text); },
    });
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 1, runner);
  const batch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ], undefined, { background: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = manager.listSessions()[0].id;
  manager.attachToSession(sessionId);

  await manager.steerSession(sessionId, "Focus on the parser");

  assert.deepEqual(steered, ["Focus on the parser"]);
  release();
  await batch.resultsPromise;
});

test("attached session details project conversation messages without exposing AgentSession", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach({
      ...makeSession(),
      messages: [
        { role: "user", content: [{ type: "text", text: "Inspect the parser" }] },
        { role: "assistant", content: [{ type: "text", text: "I found the issue." }, { type: "toolCall", name: "read", arguments: { path: "parser.ts" } }] },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "source" }], isError: false },
      ],
    });
    await gate;
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 1, runner);
  const batch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ], undefined, { background: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = manager.listSessions()[0].id;
  manager.attachToSession(sessionId);

  const detail = manager.attachedSessionDetail(sessionId);

  assert.equal(detail.session.id, sessionId);
  assert.deepEqual(detail.messages.map(message => [message.role, message.text, message.toolName]), [
    ["user", "Inspect the parser", undefined],
    ["assistant", "I found the issue.", undefined],
    ["tool", "read {\"path\":\"parser.ts\"}", "read"],
    ["toolResult", "source", "read"],
  ]);
  assert.equal("steer" in (detail as any), false);
  release();
  await batch.resultsPromise;
});

test("stopping an attached running session aborts it without detaching it", async () => {
  let abortCalls = 0;
  const runner = async (_ctx: any, agent: any) => {
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    agent.attach({
      ...makeSession(),
      abort() { abortCalls += 1; release(); },
    });
    await stopped;
    return interruptedRun(agent, "stopped");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 1, runner);
  const batch = manager.startRun(baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ], undefined, { background: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = manager.listSessions()[0].id;
  manager.attachToSession(sessionId);

  await manager.stopSession(sessionId);
  await batch.resultsPromise;

  assert.equal(abortCalls, 1);
  assert.deepEqual(manager.listAttachedSessions().map(session => session.id), [sessionId]);
});

test("removing a session clears its explicit attachment", async () => {
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 1, runner);
  const [result] = await run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "work" },
  ]);
  manager.attachToSession(result.sessionId!);

  await manager.remove({ sessionIds: [result.sessionId!] });

  assert.deepEqual(manager.listAttachedSessions(), []);
});

test("AgentManager does not expose or resume non-resumable completed sessions", async () => {
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 1, runner);

  const results = await run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work" },
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], "sessionId"), false);
  assert.deepEqual(manager.listSessions(), []);
  const [retried] = await run(manager, baseCtx(), undefined, [
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
    return completedRun(agent, `follow:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 1, mergeRunners(runner, resumeRunner));

  // Spawn-side override: session is never retained.
  const spawnResults = await run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "spawn-only", resumable: false },
  ]);
  assert.equal(spawnResults[0].status, "completed");
  assert.equal(spawnResults[0].resumable, false);
  assert.equal(Object.prototype.hasOwnProperty.call(spawnResults[0], "sessionId"), false);
  assert.deepEqual(manager.listSessions(), []);

  // Resume-side override: session retained on initial spawn, then discarded on resume.
  const [seed] = await run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial" },
  ]);
  assert.equal(manager.listSessions().length, 1);
  const [resumed] = await run(manager, baseCtx(), undefined, [
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
  const manager = makeManager(registry as any, 2, runner as any);
  const controller = new AbortController();

  const pending = run(manager, baseCtx(), controller.signal, [
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

  const [retried] = await run(manager, baseCtx(), undefined, [
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
  const manager = makeManager(registry as any, 1, mergeRunners(runner, resumeRunner));

  const results = await run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "oneshot", prompt: "work", resumable: true },
  ]);

  assert.equal(results[0].resumable, true);
  assert.ok(results[0].sessionId);
  assert.deepEqual(
    manager.listSessions().map(s => [s.id, s.config.name, s.config.resumable]),
    [[results[0].sessionId, "oneshot", true]],
  );

  const [resumed] = await run(manager, baseCtx(), undefined, [
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
      return completedRun(agent, `follow:${attempt.prompt}`);
    };
    const manager = makeManager(registry as any, 1, mergeRunners(runner, resumeRunner));

    const [initial] = await run(manager, baseCtx(), undefined, [
      { kind: "spawn", agent: "chatty", prompt: "old" },
    ]);
    assert.ok(initial.sessionId);

    now = 100_000;
    const batch = manager.startRun(baseCtx(), undefined, [
      { kind: "spawn", agent: "blocker", prompt: "block" },
      { kind: "resume", sessionId: initial.sessionId!, prompt: "queued" },
    ], undefined, { background: true });

    await new Promise(resolve => setImmediate(resolve));
    now = 100_250;
    const [queued] = toResults(manager.backgroundResults([initial.sessionId!]), { exposeId: true }) as any[];
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
      prompt: async () => { },
      abort: () => { },
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
  const manager = makeManager(registry as any, 2, mergeRunners(runner, resumeRunner));
  const results = await run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "one" },
  ]);

  assert.equal(results[0].status, "completed");
  assert.equal(results[0].output, "response:one");
  assert.ok(results[0].sessionId);
  assert.deepEqual(manager.listSessions().map(s => s.id), [results[0].sessionId]);

  const [resumed] = await run(manager, baseCtx(), undefined, [
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
  assert.equal(retained.status.kind === "done" && retained.status.output, "follow:two");

  assert.deepEqual(await manager.remove({ sessionIds: [results[0].sessionId!] }), { removed: 1, aborted: 0, sessionIds: [results[0].sessionId!], errors: [] });
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager.remove with an unknown sessionId returns the unknown-id error and no removals", async () => {
  const registry = { agents: new Map() };
  const manager = makeManager(registry as any, 1, async () => ({ status: "completed" }) as any);

  const result = await manager.remove({ sessionIds: ["unknown"] });

  assert.equal(result.removed, 0);
  assert.equal(result.aborted, 0);
  assert.deepEqual(result.sessionIds, []);
  assert.equal(result.errors!.length, 1);
  assert.equal(result.errors![0].sessionId, "unknown");
  assert.match(result.errors![0].error, /Unknown.*session/i);
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
  const manager = makeManager(registry as any, 1, runner);

  const pending = run(manager, baseCtx(), undefined, [
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
  const manager = makeManager(registry as any, 1, mergeRunners(runner, resumeRunner));
  const [seed] = await run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "seed" },
  ]);

  const pending = run(manager, baseCtx(), undefined, [
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
  const manager = makeManager(registry as any, 1, runner);
  const [seed] = await run(manager, baseCtx(), undefined, [
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

test("AgentManager.remove with a running sessionId aborts the underlying session and removes it", async () => {
  let abortCalls = 0;
  const runner = async (_ctx: any, agent: any) => {
    let resolveAbort: () => void;
    const aborted = new Promise<void>(resolve => { resolveAbort = resolve; });
    const session = {
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { abortCalls += 1; resolveAbort!(); },
    };
    agent.attach(session);
    await aborted;
    return interruptedRun(agent, "aborted by remove");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 2, runner);

  const pending = run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "work" },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const runningId = manager.listSessions()[0].id;
  assert.equal(manager.listSessions()[0].status.kind, "running");

  const removal = manager.remove({ sessionIds: [runningId] });
  assert.deepEqual(manager.listSessions(), [], "sessions disappear from public inventory as removal begins");
  const result = await removal;
  await pending;

  assert.equal(result.removed, 1);
  assert.equal(result.aborted, 1);
  assert.deepEqual(result.sessionIds, [runningId]);
  assert.equal(abortCalls, 1);
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager background non-resumable agents stay listed with terminal status after settlement", async () => {
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 2, runner);

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "work" }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;

  const listed = manager.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].dispatch, "background");
  assert.equal(listed[0].status.kind, "done");
  assert.equal(listed[0].status.kind === "done" && listed[0].status.outcome, "completed");
});

test("AgentManager.remove by sessionId aborts a running background session", async () => {
  let unblockRunning: (() => void) | undefined;
  const runningGate = new Promise<void>(resolve => { unblockRunning = resolve; });
  let abortCalls = 0;
  const runner = async (_ctx: any, agent: any) => {
    const session = {
      messages: [] as any[],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { abortCalls += 1; unblockRunning?.(); },
    };
    agent.attach(session);
    await runningGate;
    return interruptedRun(agent, "aborted by remove");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 2, runner);

  const bgBatch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "long running bg" }],
    undefined,
    { background: true },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const runningId = manager.listSessions()[0].id;
  assert.equal(manager.listSessions()[0].status.kind, "running");

  const result = await manager.remove({ sessionIds: [runningId] });
  await bgBatch.resultsPromise;

  assert.equal(result.removed, 1);
  assert.equal(result.aborted, 1);
  assert.equal(abortCalls, 1);
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager.backgroundResults returns ready:true with the projected result for a completed background session", async () => {
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "bg-output");
  };
  const registry = {
    agents: new Map([["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }]]),
  };
  const manager = makeManager(registry as any, 2, runner);

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "go" }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;
  const sessionId = batch.sessions[0].id;

  const entries = manager.backgroundResults([sessionId]);

  assert.equal(entries.length, 1);
  const [entry] = toResults(entries, { exposeId: true });
  assert.equal(entry.sessionId, sessionId);
  assert.equal((entry as any).ready, true);
  assert.equal((entry as any).result.status, "completed");
  assert.equal((entry as any).result.output, "bg-output");
  assert.equal((entry as any).result.agent, "oneshot");
  // The ready arm is the same snapshot projection as run results: it carries the run metrics.
  assert.equal(typeof (entry as any).result.turns, "number");
  assert.equal(typeof (entry as any).result.tokens, "number");
  assert.equal(typeof (entry as any).result.elapsedMs, "number");
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
  const manager = makeManager(registry as any, 2, runner);

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "longwork", label: "phase 1" }],
    undefined,
    { background: true },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessionId = batch.sessions[0].id;

  const results = toResults(manager.backgroundResults([sessionId]), { exposeId: true });

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
  const manager = makeManager(registry as any, 1, runner);

  const batch = manager.startRun(
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

  const results = toResults(manager.backgroundResults([queuedId]), { exposeId: true });

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
  const manager = makeManager(registry as any, 1, async () => ({} as any));

  const results = toResults(manager.backgroundResults(["nope"]), { exposeId: true });

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
  const manager = makeManager(registry as any, 2, runner);

  const completedBatch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "completed" }],
    undefined,
    { background: true },
  );
  await completedBatch.resultsPromise;
  const completedId = completedBatch.sessions[0].id;

  const runningBatch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "helper", prompt: "running" }],
    undefined,
    { background: true },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const runningId = runningBatch.sessions[0].id;

  const results = toResults(manager.backgroundResults([completedId, runningId, "missing", completedId]), { exposeId: true });

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

test("AgentManager.backgroundResults reads retained foreground sessions identically to background ones", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any) => {
    agent.attach(session);
    return completedRun(agent, "retained-output");
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 1, runner);

  // Foreground retained session (not started via startBatch background:true).
  const [seed] = await run(manager, baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial" },
  ]);
  assert.equal(manager.listSessions()[0].dispatch, "foreground");

  const [entry] = toResults(manager.backgroundResults([seed.sessionId!]), { exposeId: true }) as any[];
  assert.equal(entry.ready, true);
  assert.equal(entry.result.output, "retained-output");
  assert.equal(entry.result.resumable, true);
});

test("AgentManager.cancelDescendantsOfaborts direct children of the given parent id", async () => {
  const aborts: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    let resolveAbort: () => void;
    const aborted = new Promise<void>(resolve => { resolveAbort = resolve; });
    const session = {
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push(agent.spawn.prompt); resolveAbort!(); },
    };
    agent.attach(session);
    await aborted;
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined,
    { background: false, parentId: "parent-1" },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const childId = manager.listSessions()[0].id;
  assert.equal(manager.listSessions()[0].status.kind, "running");

  await manager.cancelDescendantsOf("parent-1");
  await batch.resultsPromise;

  assert.deepEqual(aborts, ["child"]);
  const finalChild = manager.listSessions().find(s => s.id === childId);
  assert.equal(finalChild?.status.kind, "done");
});

test("AgentManager.cancelDescendantsOfwalks grandchildren first (post-order)", async () => {
  const abortOrder: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    let resolveAbort: () => void;
    const aborted = new Promise<void>(resolve => { resolveAbort = resolve; });
    const session = {
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { abortOrder.push(agent.spawn.prompt); resolveAbort!(); },
    };
    agent.attach(session);
    await aborted;
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  // Manually build a 2-level tree under fake root id "root":
  //   root → child → grandchild
  const childBatch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined,
    { background: false, parentId: "root" },
  );
  await new Promise(resolve => setTimeout(resolve, 10));
  const childId = manager.listSessions().find(s => s.parentSessionId === "root")!.id;
  const grandBatch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "grandchild" }],
    undefined,
    { background: false, parentId: childId },
  );
  await new Promise(resolve => setTimeout(resolve, 10));

  await manager.cancelDescendantsOf("root");
  await Promise.all([childBatch.resultsPromise, grandBatch.resultsPromise]);

  // Post-order: grandchild's session.abort() must run before child's.
  assert.deepEqual(abortOrder, ["grandchild", "child"]);
});

test("AgentManager.cancelDescendantsOfis a no-op when the id has no descendants", async () => {
  const registry = { agents: new Map() };
  const manager = makeManager(registry as any, 4, async () => ({ status: "completed" }) as any);

  await manager.cancelDescendantsOf("nonexistent-id");
  await manager.cancelDescendantsOf("");
  assert.deepEqual(manager.listSessions(), []);
});

test("AgentManager.cancelDescendantsOfskips already-terminal descendants without re-aborting them", async () => {
  const abortCalls: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { abortCalls.push(agent.spawn.prompt); },
    });
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  // Run a child under parent-1 to completion (becomes terminal "done").
  await run(manager,
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "completed-child" }],
    undefined,
    { parentId: "parent-1" },
  );
  assert.equal(manager.listSessions().length, 1);
  assert.equal(manager.listSessions()[0].status.kind, "done");

  await manager.cancelDescendantsOf("parent-1");
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
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push(agent.spawn.prompt); flag.aborted = true; },
    });
    while (!flag.aborted) await new Promise(r => setTimeout(r, 5));
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const rootBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "root" }],
    undefined, { background: false },
  );
  await new Promise(r => setTimeout(r, 10));
  const rootId = manager.listSessions().find(s => s.parentSessionId === undefined)!.id;

  const childBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined, { background: false, parentId: rootId },
  );
  await new Promise(r => setTimeout(r, 10));
  const childId = manager.listSessions().find(s => s.parentSessionId === rootId)!.id;

  const grandBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "grandchild" }],
    undefined, { background: false, parentId: childId },
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

test("AgentManager.cancelDescendantsOf skipBackground=true cancels a running non-background descendant", async () => {
  const aborts: string[] = [];
  const runner = async (_ctx: any, agent: any) => {
    const flag = { aborted: false };
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push(agent.spawn.prompt); flag.aborted = true; },
    });
    while (!flag.aborted) await new Promise(r => setTimeout(r, 5));
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined,
    { background: false, parentId: "parent-1" },
  );
  await new Promise(r => setTimeout(r, 20));
  assert.equal(manager.listSessions()[0].status.kind, "running");

  await manager.cancelDescendantsOf("parent-1", { skipBackground: true, reason: "Parent parent-1 finalized as error" });
  await batch.resultsPromise;

  assert.deepEqual(aborts, ["child"]);
  const final = manager.listSessions()[0];
  assert.equal(final.status.kind, "done");
});

test("AgentManager.cancelDescendantsOf skipBackground=true skips background descendants", async () => {
  const aborts: string[] = [];
  const sessions: Record<string, { resolve: () => void; promise: Promise<void> }> = {};
  const runner = async (_ctx: any, agent: any) => {
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    sessions[agent.spawn.prompt] = { resolve, promise: done };
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push(agent.spawn.prompt); resolve(); },
    });
    await done;
    return interruptedRun(agent, "done");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const fgBatch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "fg" }],
    undefined,
    { background: false, parentId: "parent-1" },
  );
  const bgBatch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "bg" }],
    undefined,
    { background: true, parentId: "parent-1" },
  );
  await new Promise(r => setTimeout(r, 20));

  await manager.cancelDescendantsOf("parent-1", { skipBackground: true, reason: "Parent parent-1 finalized as error" });

  // Only the non-background child should have been aborted.
  assert.deepEqual(aborts, ["fg"]);

  // Background child still running — clean up by resolving its session.
  sessions["bg"].resolve();
  await Promise.all([fgBatch.resultsPromise, bgBatch.resultsPromise]);
});

test("AgentManager.cancelDescendantsOf stamps cancelled descendants with the reason", async () => {
  const runner = async (_ctx: any, agent: any) => {
    const flag = { aborted: false };
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { flag.aborted = true; },
    });
    while (!flag.aborted) await new Promise(r => setTimeout(r, 5));
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined,
    { background: false, parentId: "parent-9" },
  );
  await new Promise(r => setTimeout(r, 20));

  await manager.cancelDescendantsOf("parent-9", { skipBackground: true, reason: "Parent parent-9 finalized as error" });
  const [snapshot] = await batch.resultsPromise;
  const result = toResult(snapshot);

  assert.equal(result.status, "aborted");
  assert.match(result.error ?? "", /parent-9/);
  assert.match(result.error ?? "", /error/);
});

test("run updates return just the root when the root has no descendants", async () => {
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
  const manager = makeManager(registry as any, 2, runner);
  let tree: any[] = [];
  const handle = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "root" }],
    update => { tree = update.tree; },
    { background: false },
  );

  await new Promise(resolve => setTimeout(resolve, 10));
  const rootId = manager.listSessions()[0].id;

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, rootId);

  release();
  await handle.resultsPromise;
});

test("run updates walk a root → child → grandchild chain via descendant runs sharing parentSessionId", async () => {
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
  const manager = makeManager(registry as any, 4, runner);
  let tree: any[] = [];

  const rootHandle = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "root" }],
    update => { tree = update.tree; }, { background: false },
  );
  await new Promise(r => setTimeout(r, 10));
  const rootId = manager.listSessions()[0].id;
  const childHandle = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined, { background: false, parentId: rootId },
  );
  await new Promise(r => setTimeout(r, 10));
  const childId = manager.listSessions().find(s => s.parentSessionId === rootId)!.id;
  const grandHandle = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "grand" }],
    undefined, { background: false, parentId: childId },
  );
  await new Promise(r => setTimeout(r, 10));

  assert.deepEqual(
    tree.map(s => ({ id: s.id, parent: s.parentSessionId })),
    [
      { id: rootId, parent: undefined },
      { id: childId, parent: rootId },
      { id: manager.listSessions().find(s => s.parentSessionId === childId)!.id, parent: childId },
    ],
  );

  release();
  const [[rootResult]] = await Promise.all([rootHandle.resultsPromise, childHandle.resultsPromise, grandHandle.resultsPromise]);
  assert.deepEqual(
    manager.snapshotWithSubagents(rootResult).subagents?.map(snapshot => snapshot.id),
    [childId, tree[2].id],
  );
});

test("run updates order siblings by createdAt and multiple roots by input order within a single run", async () => {
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
  const manager = makeManager(registry as any, 8, runner);
  let tree: any[] = [];

  // Two-root run; tasks are listed in input order (A then B), even though under-the-hood
  // createdAt may interleave when they actually start running.
  const handle = manager.startRun(
    baseCtx(), undefined,
    [
      { kind: "spawn", agent: "worker", prompt: "rootA" },
      { kind: "spawn", agent: "worker", prompt: "rootB" },
    ],
    update => { tree = update.tree; }, { background: false },
  );
  await new Promise(r => setTimeout(r, 5));
  const allRoots = manager.listSessions().filter(s => s.parentSessionId === undefined);
  assert.equal(allRoots.length, 2);
  const rootAId = handle.sessions[0].id;
  const rootBId = handle.sessions[1].id;

  // Under rootA, add two children — the SECOND one created should sort after the first.
  const childA1 = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child-a1" }],
    undefined, { background: false, parentId: rootAId },
  );
  await new Promise(r => setTimeout(r, 5));
  const childA2 = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child-a2" }],
    undefined, { background: false, parentId: rootAId },
  );
  await new Promise(r => setTimeout(r, 5));

  const childAIds = manager.listSessions()
    .filter(s => s.parentSessionId === rootAId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(s => s.id);

  // Roots in input order (A then B); A's children appear under A in createdAt order.
  assert.deepEqual(tree.map(s => s.id), [rootAId, ...childAIds, rootBId]);

  release();
  await Promise.all([handle.resultsPromise, childA1.resultsPromise, childA2.resultsPromise]);
});

test("a foreground run emits the run-attempt, queue, and run-update spans when timing is enabled", async () => {
  const savedTiming = process.env.PI_SUBAGENT_DEBUG_TIMING;
  const savedTimingFile = process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;
  const root = await mkdtemp(join(tmpdir(), "subagent-manager-timing-"));
  const logFile = join(root, "timing.log");
  process.env.PI_SUBAGENT_DEBUG_TIMING = "1";
  process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = logFile;
  try {
    const runner = async (_ctx: any, agent: any) => {
      agent.attach(makeSession());
      return completedRun(agent, "ok");
    };
    const registry = {
      agents: new Map([["good", { name: "good", description: "", systemPrompt: "", source: "project", resumable: false }]]),
    };
    const manager = makeManager(registry as any, 1, runner);

    await manager
      .startRun(baseCtx(), undefined, [{ kind: "spawn", agent: "good", prompt: "go" }], () => {}, { background: false })
      .resultsPromise;

    const log = await readFile(logFile, "utf8");
    assert.match(log, /event=manager\.spawnTask\b/);
    assert.match(log, /event=queue\.task\b/);
    assert.match(log, /event=manager\.emitRunUpdate\b/);
  } finally {
    if (savedTiming === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING;
    else process.env.PI_SUBAGENT_DEBUG_TIMING = savedTiming;
    if (savedTimingFile === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;
    else process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = savedTimingFile;
    await rm(root, { recursive: true, force: true });
  }
});
