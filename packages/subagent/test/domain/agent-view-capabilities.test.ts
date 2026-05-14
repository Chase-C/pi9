import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent } from "../../src/domain/agent.js";
import { completedRun, errorRun } from "../../src/domain/agent-result.js";
import {
  preflightResumeFailure,
  preflightSpawnFailure,
} from "../../src/domain/preflight-failure.js";

const baseConfig = {
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
  resumable: false,
};

const resumableConfig = { ...baseConfig, resumable: true };

function fakeSession() {
  return { messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} } as any;
}

test("Agent.toView capabilities: resumable in-flight (queued or running) reports neither flag", () => {
  const queued = new Agent("id1", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  assert.deepEqual(queued.toView().capabilities, { canResume: false, canClear: false });

  const running = new Agent("id2", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  running.attach(fakeSession());
  assert.deepEqual(running.toView().capabilities, { canResume: false, canClear: false });
});

test("Agent.toView capabilities: non-resumable reports both flags false in every state", () => {
  const queued = new Agent("id1", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  assert.deepEqual(queued.toView().capabilities, { canResume: false, canClear: false });

  const completed = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  completed.attach(fakeSession());
  completedRun(completed, "done");
  assert.deepEqual(completed.toView().capabilities, { canResume: false, canClear: false });
});

test("Agent.toView capabilities: completed resumable agent can both resume and clear", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  agent.attach(fakeSession());
  completedRun(agent, "done");
  assert.deepEqual(agent.toView().capabilities, { canResume: true, canClear: true });
});

test("Agent.toView capabilities: errored resumable agent is clearable but not resumable", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  agent.attach(fakeSession());
  errorRun(agent, "boom");
  assert.deepEqual(agent.toView().capabilities, { canResume: false, canClear: true });
});

test("Agent.toView capabilities: pre-attach failure on resumable agent remains resumable", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  // Seed a retained session via a completed first attempt, then simulate a follow-up that fails before attach.
  agent.attach(fakeSession());
  completedRun(agent, "first");
  agent.startResume({ kind: "resume", sessionId: agent.id, prompt: "follow" });
  errorRun(agent, "setup failed");
  assert.deepEqual(agent.toView().capabilities, { canResume: true, canClear: true });
});

test("Agent.toView capabilities: resume attempt in flight cannot resume or clear", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  agent.attach(fakeSession());
  completedRun(agent, "first");
  agent.startResume({ kind: "resume", sessionId: agent.id, prompt: "follow" });
  agent.attach(fakeSession());
  assert.deepEqual(agent.toView().capabilities, { canResume: false, canClear: false });
});

test("preflight failure views report capabilities false for both spawn and resume", () => {
  const spawn = preflightSpawnFailure({
    groupId: "g", inputIndex: 0, createdAt: Date.now(),
    task: { kind: "spawn", agent: "missing", prompt: "p" },
    error: "Unknown agent",
  });
  assert.deepEqual(spawn.view.capabilities, { canResume: false, canClear: false });

  const resume = preflightResumeFailure({
    groupId: "g", inputIndex: 0, createdAt: Date.now(),
    task: { kind: "resume", sessionId: "unknown", prompt: "p" },
    target: undefined,
    error: "Unknown resumable subagent session",
  });
  assert.deepEqual(resume.view.capabilities, { canResume: false, canClear: false });
});
