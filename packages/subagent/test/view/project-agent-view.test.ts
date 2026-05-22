import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { projectAgentView } from "../../src/view/project-agent-view.js";

const fakeSession = { subscribe: () => () => {}, abort: () => {} } as any;

const baseConfig = {
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
  resumable: false,
};

test("projectAgentView labels a fresh foreground spawn as foreground+transient", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" });
  const view = projectAgentView(agent);
  assert.equal(view.dispatch, "foreground");
  assert.equal(view.retention, "transient");
});

test("projectAgentView marks background-dispatched agents as dispatch=background and retention=persistent", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, { background: true });
  const view = projectAgentView(agent);
  assert.equal(view.dispatch, "background");
  assert.equal(view.retention, "persistent");
});

test("projectAgentView marks a completed foreground resumable agent as persistent", () => {
  const config = { ...baseConfig, resumable: true };
  const agent = new Agent("id", config, { kind: "spawn", agent: "helper", prompt: "work" });
  agent.attach(fakeSession);
  completedRun(agent, "done");
  const view = projectAgentView(agent);
  assert.equal(view.dispatch, "foreground");
  assert.equal(view.retention, "persistent");
});

test("projectAgentView marks a completed foreground non-resumable agent as transient", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" });
  agent.attach(fakeSession);
  completedRun(agent, "done");
  const view = projectAgentView(agent);
  assert.equal(view.dispatch, "foreground");
  assert.equal(view.retention, "transient");
});

test("projectAgentView preserves the raw done snippet without truncating it (compaction lives in the formatter)", () => {
  const raw = "x".repeat(200);
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" });
  agent.attach(fakeSession);
  completedRun(agent, raw);
  const view = projectAgentView(agent);
  if (view.status.kind !== "done") throw new Error("expected done status");
  assert.equal(view.status.snippet, raw);
});
