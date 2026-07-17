import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import { completedRun, errorRun } from "../../src/domain/agent-finalize.js";
import { preflightFailure } from "../../src/domain/preflight-failure.js";
import { resolveTask } from "../../src/runtime/task-resolution.js";

const noop: AgentUpdateListener = () => {};
const view = (agent: Agent) => agent.snapshot();

const baseConfig = {
  retainConversation: false,
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
};

const retainConversationConfig = { ...baseConfig, retainConversation: true };

function fakeSession() {
  return { messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} } as any;
}

/** Drives a resume through the runtime resolver so the test mirrors the production code path. */
function resumeAgent(agent: Agent, prompt: string): void {
  const registry = { agents: new Map([[agent.agentName, agent.config]]) } as any;
  const result = resolveTask({
    task: { kind: "resume", sessionId: agent.id, prompt },
    dispatch: "foreground", groupId: "g", inputIndex: 0,
    registry, findAgent: id => (id === agent.id ? agent : undefined),
    allocateSessionId: () => "test-session", listener: noop,
  });
  if (result.kind !== "resume") throw new Error(`expected resume, got ${result.kind}`);
}

test("active retain-policy attempts cannot resume or be removed", () => {
  const queued = new Agent("id1", retainConversationConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.deepEqual(view(queued).capabilities, { canResume: false, canRemove: false });

  const running = new Agent("id2", retainConversationConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  running.bindSession(fakeSession());
  assert.deepEqual(view(running).capabilities, { canResume: false, canRemove: false });
});

test("release-policy foreground attempts have no terminal capabilities", () => {
  const queued = new Agent("id1", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.deepEqual(view(queued).capabilities, { canResume: false, canRemove: false });

  const completed = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  completed.bindSession(fakeSession());
  completedRun(completed, "done");
  assert.deepEqual(view(completed).capabilities, { canResume: false, canRemove: false });
});

test("a completed background result releases its conversation and cannot regain resume capability", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop, { dispatch: "background" });
  agent.bindSession(fakeSession());
  completedRun(agent, "done");

  assert.equal(agent.retainedSession(), undefined);
  assert.equal(view(agent).conversation.available, false);
  assert.deepEqual(view(agent).capabilities, { canResume: false, canRemove: true });

});

test("terminal removal follows persistent catalog membership across outcomes", () => {
  const outcomes = ["completed", "error", "interrupted", "aborted", "skipped"] as const;
  for (const outcome of outcomes) {
    const persistentForeground = new Agent(`fg-${outcome}`, retainConversationConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
    persistentForeground.bindSession(fakeSession());
    persistentForeground.settle(outcome === "completed" ? { status: outcome, output: "done" } : { status: outcome, error: outcome });
    assert.equal(view(persistentForeground).capabilities.canRemove, true, `persistent foreground ${outcome}`);

    const persistentBackground = new Agent(`bg-${outcome}`, baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop, { dispatch: "background" });
    persistentBackground.bindSession(fakeSession());
    persistentBackground.settle(outcome === "completed" ? { status: outcome, output: "done" } : { status: outcome, error: outcome });
    assert.equal(view(persistentBackground).capabilities.canRemove, true, `background ${outcome}`);

    const transientForeground = new Agent(`transient-${outcome}`, baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
    transientForeground.bindSession(fakeSession());
    transientForeground.settle(outcome === "completed" ? { status: outcome, output: "done" } : { status: outcome, error: outcome });
    assert.equal(view(transientForeground).capabilities.canRemove, false, `transient foreground ${outcome}`);
  }
});

test("a successfully completed retained conversation can resume and be removed", () => {
  const agent = new Agent("id", retainConversationConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.bindSession(fakeSession());
  completedRun(agent, "done");
  assert.deepEqual(view(agent).capabilities, { canResume: true, canRemove: true });
});

test("a post-bind error remains removable but cannot resume", () => {
  const agent = new Agent("id", retainConversationConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.bindSession(fakeSession());
  errorRun(agent, "boom");
  assert.deepEqual(view(agent).capabilities, { canResume: false, canRemove: true });
});

test("a pre-bind resume failure preserves resume capability", () => {
  const agent = new Agent("id", retainConversationConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  // Seed a retained session via a completed first attempt, then simulate a follow-up that fails before binding.
  agent.bindSession(fakeSession());
  completedRun(agent, "first");
  resumeAgent(agent, "follow");
  errorRun(agent, "setup failed");
  assert.deepEqual(view(agent).capabilities, { canResume: true, canRemove: true });

  resumeAgent(agent, "retry");
  errorRun(agent, "setup failed again");
  assert.deepEqual(view(agent).capabilities, { canResume: true, canRemove: true });
});

test("an active resume cannot resume again or be removed", () => {
  const agent = new Agent("id", retainConversationConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.bindSession(fakeSession());
  completedRun(agent, "first");
  resumeAgent(agent, "follow");
  agent.bindSession(fakeSession());
  assert.deepEqual(view(agent).capabilities, { canResume: false, canRemove: false });
});

test("preflight failure snapshots have no capabilities for spawn or resume", () => {
  const spawn = preflightFailure(
    {
      groupId: "g", inputIndex: 0,
      task: { kind: "spawn", agent: "missing", prompt: "p" },
      dispatch: "foreground",
    },
    { error: "Unknown agent" },
  );
  assert.deepEqual(spawn.capabilities, { canResume: false, canRemove: false });

  const resume = preflightFailure(
    {
      groupId: "g", inputIndex: 0,
      task: { kind: "resume", sessionId: "unknown", prompt: "p" },
      dispatch: "foreground",
    },
    { error: "Unknown retained subagent session" },
  );
  assert.deepEqual(resume.capabilities, { canResume: false, canRemove: false });
});
