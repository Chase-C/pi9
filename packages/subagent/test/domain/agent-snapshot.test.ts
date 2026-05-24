import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";

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

test("snapshot preserves the raw done snippet without truncating it (compaction lives in the formatter)", () => {
  const raw = "x".repeat(200);
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  agent.attach(fakeSession);
  completedRun(agent, raw);
  const view = agent.snapshot();
  if (view.status.kind !== "done") throw new Error("expected done status");
  assert.equal(view.status.snippet, raw);
});
