import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { resolveTask } from "../../src/runtime/task-resolution.js";

const noop: AgentUpdateListener = () => {};
const fakeSession = { subscribe: () => () => {}, abort: () => {} } as any;

const baseConfig = {
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
  resumable: false,
};

test("snapshot labels a fresh foreground spawn as foreground+transient", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  const view = agent.snapshot();
  assert.equal(view.dispatch, "foreground");
  assert.equal(view.retention, "transient");
});

test("snapshot marks background-dispatched agents as dispatch=background and retention=persistent", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop, { background: true });
  const view = agent.snapshot();
  assert.equal(view.dispatch, "background");
  assert.equal(view.retention, "persistent");
});

test("snapshot marks a completed foreground resumable agent as persistent", () => {
  const config = { ...baseConfig, resumable: true };
  const agent = new Agent("id", config, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  agent.attach(fakeSession);
  completedRun(agent, "done");
  const view = agent.snapshot();
  assert.equal(view.dispatch, "foreground");
  assert.equal(view.retention, "persistent");
});

test("snapshot marks a completed foreground non-resumable agent as transient", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  agent.attach(fakeSession);
  completedRun(agent, "done");
  const view = agent.snapshot();
  assert.equal(view.dispatch, "foreground");
  assert.equal(view.retention, "transient");
});

test("direct snapshots omit top-level resumed while terminal status derives it from the attempt", () => {
  const config = { ...baseConfig, resumable: true };
  const agent = new Agent("id", config, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  agent.attach(fakeSession);
  completedRun(agent, "first");

  const spawnView = agent.snapshot();
  assert.equal(Object.prototype.hasOwnProperty.call(spawnView, "resumed"), false);
  assert.equal(spawnView.status.kind, "done");
  assert.equal(spawnView.status.kind === "done" && spawnView.status.resumed, false);

  const resolved = resolveTask({
    task: { kind: "resume", sessionId: agent.id, prompt: "follow-up" },
    background: false,
    groupId: "g",
    inputIndex: 0,
    registry: { agents: new Map([["helper", config]]) } as any,
    findAgent: id => id === agent.id ? agent : undefined,
    listener: noop,
  });
  if (resolved.kind !== "resume") throw new Error("expected resume");
  const liveView = resolved.agent.snapshot();
  assert.equal(Object.prototype.hasOwnProperty.call(liveView, "resumed"), false);
  assert.equal(liveView.status.kind, "queued");

  resolved.agent.attach(fakeSession);
  completedRun(resolved.agent, "follow-up");
  const resumeView = resolved.agent.snapshot();
  assert.equal(Object.prototype.hasOwnProperty.call(resumeView, "resumed"), false);
  assert.equal(resumeView.status.kind, "done");
  assert.equal(resumeView.status.kind === "done" && resumeView.status.resumed, true);
});

test("snapshot preserves the raw done output without truncating it (compaction lives in the formatter)", () => {
  const raw = "x".repeat(200);
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  agent.attach(fakeSession);
  completedRun(agent, raw);
  const view = agent.snapshot();
  if (view.status.kind !== "done") throw new Error("expected done status");
  assert.equal(view.status.output, raw);
});
