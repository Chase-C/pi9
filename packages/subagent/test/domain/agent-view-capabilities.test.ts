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

test("Agent.toView capabilities: queued non-resumable agent reports neither canResume nor canClear", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  assert.deepEqual(agent.toView().capabilities, { canResume: false, canClear: false });
});

test("Agent.toView capabilities: queued resumable agent cannot resume or clear while active", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  assert.deepEqual(agent.toView().capabilities, { canResume: false, canClear: false });
});

test("Agent.toView capabilities: running resumable agent cannot resume or clear", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  agent.attach(fakeSession());
  assert.deepEqual(agent.toView().capabilities, { canResume: false, canClear: false });
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

test("Agent.toView capabilities: completed non-resumable agent is neither resumable nor clearable", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" });
  agent.attach(fakeSession());
  completedRun(agent, "done");
  assert.deepEqual(agent.toView().capabilities, { canResume: false, canClear: false });
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

test("preflightSpawnFailure view always reports capabilities false", () => {
  const { view } = preflightSpawnFailure({
    groupId: "g", inputIndex: 0, createdAt: Date.now(),
    task: { kind: "spawn", agent: "missing", prompt: "p" },
    error: "Unknown agent",
  });
  assert.deepEqual(view.capabilities, { canResume: false, canClear: false });
});

test("preflightResumeFailure view always reports capabilities false", () => {
  const { view } = preflightResumeFailure({
    groupId: "g", inputIndex: 0, createdAt: Date.now(),
    task: { kind: "resume", sessionId: "unknown", prompt: "p" },
    target: undefined,
    error: "Unknown resumable subagent session",
  });
  assert.deepEqual(view.capabilities, { canResume: false, canClear: false });
});
