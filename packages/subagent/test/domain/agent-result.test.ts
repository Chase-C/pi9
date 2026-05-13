import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentStatus } from "../../src/domain/agent.js";
import { buildAgentResult, completedRun, errorRun, interruptedRun } from "../../src/domain/agent-result.js";

function doneStatus(agent: Agent): Extract<AgentStatus, { kind: "done" }> {
  if (agent.status.kind !== "done") throw new Error(`expected done, got ${agent.status.kind}`);
  return agent.status;
}

const baseConfig = {
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
  resumable: false,
};

test("AgentRunResult propagates label from agent through completed/error/interrupted runs", () => {
  const labeled = new Agent("id1", baseConfig, { agent: "helper" }, { prompt: "work", label: "researcher" });
  assert.equal(completedRun(labeled, "done").label, "researcher");

  const labeledErr = new Agent("id2", baseConfig, { agent: "helper" }, { prompt: "work", label: "researcher" });
  assert.equal(errorRun(labeledErr, "fail").label, "researcher");

  const labeledInt = new Agent("id3", baseConfig, { agent: "helper" }, { prompt: "work", label: "researcher" });
  assert.equal(interruptedRun(labeledInt, "stop").label, "researcher");

  const unlabeled = new Agent("id4", baseConfig, { agent: "helper" }, { prompt: "work" });
  const result = completedRun(unlabeled, "done");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "label"), false);
});

test("AgentRunResult resumable reflects the per-task override", () => {
  const config = { ...baseConfig, resumable: false };
  const session = { subscribe: () => () => {}, abort: () => {} };

  const agent = new Agent("id1", config, { agent: "helper" }, { prompt: "work", resumable: true });
  agent.attach(session as any);
  const result = completedRun(agent, "done");

  assert.equal(result.resumable, true);
  assert.equal(result.sessionId, "id1");
});

test("agent transitions through start, finalize, and is idempotent on second finalize", () => {
  const config = { name: "agent", description: "desc", systemPrompt: "prompt", source: "project" as const, resumable: false };
  const spawn = { agent: "agent" };
  const invocation = { prompt: "do work" };
  const session = { subscribe: () => () => {}, abort: () => {} };

  const running = new Agent("id", config, spawn, invocation);
  running.attach(session as any);
  assert.equal(running.status.kind, "running");
  assert.throws(() => running.attach(session as any), /Cannot attach/);

  completedRun(running, "done");
  const firstDone = doneStatus(running);
  assert.equal(firstDone.result.status, "completed");
  assert.equal(firstDone.result.output, "done");

  errorRun(running, "late");
  const stillDone = doneStatus(running);
  assert.equal(stillDone.result.status, "completed", "finalize is idempotent — terminal state is sticky");

  const queued = new Agent("q", config, spawn, invocation);
  errorRun(queued, "failed before start");
  const queuedDone = doneStatus(queued);
  assert.equal(queuedDone.result.status, "error");
  assert.equal(queuedDone.result.error, "failed before start");
});

test("buildAgentResult throws a clear invariant error when no attempt is current", () => {
  const agent = new Agent("id", baseConfig, { agent: "helper" }, { prompt: "work" });
  agent.attach({ subscribe: () => () => {}, abort: () => {} } as any);
  completedRun(agent, "done");

  assert.throws(() => buildAgentResult(agent, { status: "error", error: "late" }), /current attempt/i);
});

test("completedRun marks the result as not resumed by default", () => {
  const session = { subscribe: () => () => {}, abort: () => {} };
  const agent = new Agent("id", baseConfig, { agent: "helper" }, { prompt: "p" });
  agent.attach(session as any);

  const result = completedRun(agent, "done");
  assert.equal(result.resumed, false);
});
