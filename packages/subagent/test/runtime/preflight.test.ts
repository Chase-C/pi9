import { test } from "vitest";
import assert from "node:assert/strict";

import { completedRun } from "../../src/domain/agent-result.js";
import { baseCtx, makeManagerAndOrchestrator, makeSession, mergeRunners } from "../helpers/runtime.js";

type FakeRegistry = { agents: Map<string, any>; reload?: () => Promise<void>; summarizeAgent?: () => string };

test("preflight spawn failure carries the input label on unknown-agent synthetic results and views", async () => {
  const registry: FakeRegistry = { agents: new Map() };
  const { orchestrator } = makeManagerAndOrchestrator(registry as any, 2, async () => ({ status: "completed" }) as any);

  let lastUpdate: any;
  const results = await orchestrator.run(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "missing", prompt: "do work", label: "researcher" }],
    update => { lastUpdate = update; },
  );

  assert.equal(results[0].label, "researcher");
  assert.equal(lastUpdate.sessions[0].label, "researcher");
});

test("preflight rejects duplicate resume tasks without corrupting the retained session", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(session);
    return completedRun(agent, `old:${attempt.prompt}`);
  };
  let finishResume: () => void;
  const resumeCanFinish = new Promise<void>(resolve => { finishResume = resolve; });
  const resumePrompts: string[] = [];
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => {
    resumePrompts.push(attempt.prompt);
    if (attempt.prompt !== "first follow-up") throw new Error(`duplicate resume runner invoked for ${attempt.prompt}`);
    agent.attach(agent.retainedSession()!);
    await resumeCanFinish;
    return completedRun(agent, `new:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["chatty", { name: "chatty", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const { manager, orchestrator } = makeManagerAndOrchestrator(registry as any, 2, mergeRunners(runner, resumeRunner));
  const [first] = await orchestrator.run(baseCtx(), undefined, [
    { kind: "spawn", agent: "chatty", prompt: "initial prompt" },
  ]);

  const pending = orchestrator.run(baseCtx(), undefined, [
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

test("preflight resume failure for an unknown sessionId yields a per-task error and does not block siblings", async () => {
  const session = makeSession();
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach(session);
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const registry = {
    agents: new Map([["fresh", { name: "fresh", description: "d", systemPrompt: "s", source: "project" }]]),
  };
  const { orchestrator } = makeManagerAndOrchestrator(registry as any, 2, runner);

  const results = await orchestrator.run(baseCtx(), undefined, [
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
