import { test } from "vitest";
import assert from "node:assert/strict";

import { completedRun } from "../../src/domain/agent-result.js";
import { baseCtx, makeManagerAndOrchestrator, makeSession, mergeRunners } from "../helpers/runtime.js";

test("AttemptRunner marks runner rejections before start as terminal error in grouped progress", async () => {
  const runner = async () => { throw new Error("setup failed before start"); };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner as any);
  const updates: any[] = [];

  const results = await orchestrator.run(
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

test("AttemptRunner returns skipped result and final group row for queued task whose signal aborted before it can start", async () => {
  const calls: string[] = [];
  let finishFirst: () => void;
  const firstCanFinish = new Promise<void>(resolve => { finishFirst = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    calls.push(attempt.prompt);
    agent.attach(makeSession());
    if (attempt.prompt === "one") await firstCanFinish;
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["helper", { name: "helper", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, runner);
  const controller = new AbortController();
  const updates: any[] = [];

  const pending = orchestrator.run(
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

test("AttemptRunner reports resume setup failure as the follow-up prompt error without returning prior completion", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(session);
    return completedRun(agent, `old:${attempt.prompt}`);
  };
  const resumeRunner = async () => { throw new Error("resume setup exploded"); };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { orchestrator } = makeManagerAndOrchestrator(registry as any, 1, mergeRunners(runner, resumeRunner) as any);
  const [first] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial prompt" },
  ]);

  const [resumed] = await orchestrator.run(baseCtx(), undefined, [
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

test("AttemptRunner keeps a retained completed session retryable across one or more pre-attach resume failures", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(session);
    return completedRun(agent, `old:${attempt.prompt}`);
  };
  let resumeAttempts = 0;
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    resumeAttempts += 1;
    if (resumeAttempts <= 2) throw new Error(`resume failed #${resumeAttempts}`);
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `new:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, mergeRunners(runner, resumeRunner));
  const [first] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial prompt" },
  ]);

  // Two consecutive failures keep the session retryable each time.
  for (const attempt of [1, 2] as const) {
    const [failed] = await orchestrator.run(baseCtx(), undefined, [
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
  const [retried] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: first.sessionId!, prompt: "successful follow-up" },
  ]);
  assert.equal(retried.status, "completed");
  assert.equal(retried.output, "new:successful follow-up");
  assert.equal(retried.sessionId, first.sessionId);
  const finalView = manager.listSessions()[0];
  assert.equal(finalView.status.kind === "done" && finalView.status.outcome, "completed");
  assert.equal(finalView.status.kind === "done" && finalView.status.snippet, "new:successful follow-up");
});

test("AttemptRunner reports queued cancelled resume as skipped follow-up and keeps retained session retryable", async () => {
  let finishBlocker: () => void;
  const blockerCanFinish = new Promise<void>(resolve => { finishBlocker = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(makeSession());
    if (attempt.prompt === "blocker prompt") await blockerCanFinish;
    return completedRun(agent, `output:${attempt.prompt}`);
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(agent.retainedSession()!);
    return completedRun(agent, `resumed:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([
      ["blocker", { name: "blocker", description: "d", systemPrompt: "s", source: "project", resumable: false }],
      ["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }],
    ]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 1, mergeRunners(runner, resumeRunner));
  const [first] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial prompt" },
  ]);

  const controller = new AbortController();
  const updates: any[] = [];
  const pending = orchestrator.run(
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

  const [retried] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "resume", sessionId: first.sessionId!, prompt: "retry prompt" },
  ]);
  assert.equal(retried.status, "completed");
  assert.equal(retried.output, "resumed:retry prompt");
  assert.equal(retried.sessionId, first.sessionId);
});
