import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import { completedRun, errorRun } from "../../src/domain/agent-finalize.js";
import { preflightFailure } from "../../src/domain/preflight-failure.js";

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

/** Drives a resume through Agent.resolve so the test mirrors the production code path. */
function resumeAgent(agent: Agent, prompt: string): void {
  const registry = { agents: new Map([[agent.agentName, agent.config]]) } as any;
  const result = Agent.resolve({
    task: { kind: "resume", sessionId: agent.id, prompt },
    background: false, groupId: "g", inputIndex: 0, createdAt: Date.now(),
    registry, findAgent: id => (id === agent.id ? agent : undefined), listener: noop,
  });
  if (result.kind !== "resume") throw new Error(`expected resume, got ${result.kind}`);
}

test("projectAgentView capabilities: resumable in-flight (queued or running) reports neither flag", () => {
  const queued = new Agent("id1", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.deepEqual(view(queued).capabilities, { canResume: false, canClear: false });

  const running = new Agent("id2", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  running.attach(fakeSession());
  assert.deepEqual(view(running).capabilities, { canResume: false, canClear: false });
});

test("projectAgentView capabilities: non-resumable reports both flags false in every state", () => {
  const queued = new Agent("id1", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.deepEqual(view(queued).capabilities, { canResume: false, canClear: false });

  const completed = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  completed.attach(fakeSession());
  completedRun(completed, "done");
  assert.deepEqual(view(completed).capabilities, { canResume: false, canClear: false });
});

test("projectAgentView capabilities: completed resumable agent can both resume and clear", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(fakeSession());
  completedRun(agent, "done");
  assert.deepEqual(view(agent).capabilities, { canResume: true, canClear: true });
});

test("projectAgentView capabilities: errored resumable agent is clearable but not resumable", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(fakeSession());
  errorRun(agent, "boom");
  assert.deepEqual(view(agent).capabilities, { canResume: false, canClear: true });
});

test("projectAgentView capabilities: pre-attach failure on resumable agent remains resumable", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  // Seed a retained session via a completed first attempt, then simulate a follow-up that fails before attach.
  agent.attach(fakeSession());
  completedRun(agent, "first");
  resumeAgent(agent, "follow");
  errorRun(agent, "setup failed");
  assert.deepEqual(view(agent).capabilities, { canResume: true, canClear: true });
});

test("projectAgentView capabilities: resume attempt in flight cannot resume or clear", () => {
  const agent = new Agent("id", resumableConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(fakeSession());
  completedRun(agent, "first");
  resumeAgent(agent, "follow");
  agent.attach(fakeSession());
  assert.deepEqual(view(agent).capabilities, { canResume: false, canClear: false });
});

test("preflight failure views report capabilities false for both spawn and resume", () => {
  const spawn = preflightFailure(
    {
      groupId: "g", inputIndex: 0, createdAt: Date.now(),
      task: { kind: "spawn", agent: "missing", prompt: "p" },
      background: false,
    },
    { error: "Unknown agent" },
  );
  assert.deepEqual(spawn.view.capabilities, { canResume: false, canClear: false });

  const resume = preflightFailure(
    {
      groupId: "g", inputIndex: 0, createdAt: Date.now(),
      task: { kind: "resume", sessionId: "unknown", prompt: "p" },
      background: false,
    },
    { error: "Unknown resumable subagent session" },
  );
  assert.deepEqual(resume.view.capabilities, { canResume: false, canClear: false });
});
