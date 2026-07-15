import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import { completedRun, errorRun } from "../../src/domain/agent-finalize.js";
import { preflightFailure } from "../../src/domain/preflight-failure.js";
import { resolveTask } from "../../src/runtime/task-resolution.js";

const noop: AgentUpdateListener = () => {};
const view = (agent: Agent) => agent.snapshot();

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

/** Drives a resume through the runtime resolver so the test mirrors the production code path. */
function resumeAgent(agent: Agent, prompt: string): void {
  const registry = { agents: new Map([[agent.agentName, agent.config]]) } as any;
  const result = resolveTask({
    task: { kind: "resume", sessionId: agent.id, prompt },
    background: false, groupId: "g", inputIndex: 0,
    registry, findAgent: id => (id === agent.id ? agent : undefined), listener: noop,
  });
  if (result.kind !== "resume") throw new Error(`expected resume, got ${result.kind}`);
}

test("projectAgentView capabilities: resumable in-flight (queued or running) reports neither flag", () => {
  const queued = new Agent("id1", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.deepEqual(view(queued).capabilities, { canResume: false, canRemove: false, canClear: false });

  const running = new Agent("id2", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  running.attach(fakeSession());
  assert.deepEqual(view(running).capabilities, { canResume: false, canRemove: false, canClear: false });
});

test("projectAgentView capabilities: non-resumable reports both flags false in every state", () => {
  const queued = new Agent("id1", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.deepEqual(view(queued).capabilities, { canResume: false, canRemove: false, canClear: false });

  const completed = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  completed.attach(fakeSession());
  completedRun(completed, "done");
  assert.deepEqual(view(completed).capabilities, { canResume: false, canRemove: false, canClear: false });
});

test("projectAgentView capabilities: completed non-resumable background agent is removable", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop, { background: true });
  agent.attach(fakeSession());
  completedRun(agent, "done");
  assert.equal(view(agent).capabilities.canRemove, true);
});

test("projectAgentView capabilities: safe removal follows catalog membership across terminal outcomes", () => {
  const outcomes = ["completed", "error", "interrupted", "aborted", "skipped"] as const;
  for (const outcome of outcomes) {
    const persistentForeground = new Agent(`fg-${outcome}`, resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
    persistentForeground.attach(fakeSession());
    persistentForeground.settle(outcome === "completed" ? { status: outcome, output: "done" } : { status: outcome, error: outcome });
    assert.equal(view(persistentForeground).capabilities.canRemove, true, `persistent foreground ${outcome}`);
    assert.equal(view(persistentForeground).capabilities.canClear, true, `foreground alias ${outcome}`);

    const persistentBackground = new Agent(`bg-${outcome}`, baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop, { background: true });
    persistentBackground.attach(fakeSession());
    persistentBackground.settle(outcome === "completed" ? { status: outcome, output: "done" } : { status: outcome, error: outcome });
    assert.equal(view(persistentBackground).capabilities.canRemove, true, `background ${outcome}`);
    assert.equal(view(persistentBackground).capabilities.canClear, true, `background alias ${outcome}`);

    const transientForeground = new Agent(`transient-${outcome}`, baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
    transientForeground.attach(fakeSession());
    transientForeground.settle(outcome === "completed" ? { status: outcome, output: "done" } : { status: outcome, error: outcome });
    assert.equal(view(transientForeground).capabilities.canRemove, false, `transient foreground ${outcome}`);
    assert.equal(view(transientForeground).capabilities.canClear, false, `transient alias ${outcome}`);
  }
});

test("projectAgentView capabilities: completed resumable agent can both resume and clear", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(fakeSession());
  completedRun(agent, "done");
  assert.deepEqual(view(agent).capabilities, { canResume: true, canRemove: true, canClear: true });
});

test("projectAgentView capabilities: errored resumable agent is clearable but not resumable", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(fakeSession());
  errorRun(agent, "boom");
  assert.deepEqual(view(agent).capabilities, { canResume: false, canRemove: true, canClear: true });
});

test("projectAgentView capabilities: pre-attach failure on resumable agent remains resumable", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  // Seed a retained session via a completed first attempt, then simulate a follow-up that fails before attach.
  agent.attach(fakeSession());
  completedRun(agent, "first");
  resumeAgent(agent, "follow");
  errorRun(agent, "setup failed");
  assert.deepEqual(view(agent).capabilities, { canResume: true, canRemove: true, canClear: true });
});

test("projectAgentView capabilities: resume attempt in flight cannot resume or clear", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(fakeSession());
  completedRun(agent, "first");
  resumeAgent(agent, "follow");
  agent.attach(fakeSession());
  assert.deepEqual(view(agent).capabilities, { canResume: false, canRemove: false, canClear: false });
});

test("preflight failure views report capabilities false for both spawn and resume", () => {
  const spawn = preflightFailure(
    {
      groupId: "g", inputIndex: 0,
      task: { kind: "spawn", agent: "missing", prompt: "p" },
      background: false,
    },
    { error: "Unknown agent" },
  );
  assert.deepEqual(spawn.capabilities, { canResume: false, canRemove: false, canClear: false });

  const resume = preflightFailure(
    {
      groupId: "g", inputIndex: 0,
      task: { kind: "resume", sessionId: "unknown", prompt: "p" },
      background: false,
    },
    { error: "Unknown resumable subagent session" },
  );
  assert.deepEqual(resume.capabilities, { canResume: false, canRemove: false, canClear: false });
});
