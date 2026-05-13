import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentStatus } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-result.js";

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

test("Agent exposes the label from options and falls back to undefined when absent", () => {
  const labeled = new Agent("id1", baseConfig, { agent: "helper" }, { prompt: "work", label: "researcher" });
  assert.equal(labeled.label, "researcher");

  const unlabeled = new Agent("id2", baseConfig, { agent: "helper" }, { prompt: "work" });
  assert.equal(unlabeled.label, undefined);
});

test("Agent exposes the per-task skills array as-is and preserves undefined when absent", () => {
  const withSkills = new Agent("id1", baseConfig, { agent: "helper", skills: ["tdd"] }, { prompt: "work" });
  assert.deepEqual(withSkills.spawn.skills, ["tdd"]);

  const explicitlyEmpty = new Agent("id2", baseConfig, { agent: "helper", skills: [] }, { prompt: "work" });
  assert.deepEqual(explicitlyEmpty.spawn.skills, []);

  const without = new Agent("id3", baseConfig, { agent: "helper" }, { prompt: "work" });
  assert.equal(without.spawn.skills, undefined);
});

test("Agent constructor optional background flag controls toView kind", () => {
  const defaultAgent = new Agent("id1", baseConfig, { agent: "helper" }, { prompt: "p" });
  assert.equal(defaultAgent.background, false);
  assert.equal(defaultAgent.toView().kind, "retained");

  const backgroundAgent = new Agent("id2", baseConfig, { agent: "helper" }, { prompt: "p" }, { background: true });
  assert.equal(backgroundAgent.background, true);
  assert.equal(backgroundAgent.toView().kind, "background");
});

test("Agent.toView surfaces the default skills from the agent config", () => {
  const config = { ...baseConfig, skills: ["foo", "bar"] };
  const agent = new Agent("id", config, { agent: "helper" }, { prompt: "work" });
  assert.deepEqual(agent.toView().config.skills, ["foo", "bar"]);

  const noSkills = new Agent("id2", baseConfig, { agent: "helper" }, { prompt: "work" });
  assert.equal(noSkills.toView().config.skills, undefined);
});

test("Agent uses a per-task resumable false override before the config default", () => {
  const config = { ...baseConfig, resumable: true };
  const agent = new Agent("id", config, { agent: "helper" }, { prompt: "work", resumable: false });

  assert.equal(agent.resumable, false);
  assert.equal(agent.toView().config.resumable, false);
});

test("Agent uses a per-task resumable true override before the config default", () => {
  const config = { ...baseConfig, resumable: false };
  const agent = new Agent("id", config, { agent: "helper" }, { prompt: "work", resumable: true });

  assert.equal(agent.resumable, true);
  assert.equal(agent.toView().config.resumable, true);
});

test("Agent.toView includes label when set and omits it otherwise", () => {
  const labeled = new Agent("id1", baseConfig, { agent: "helper" }, { prompt: "work", label: "researcher" });
  assert.equal(labeled.toView().label, "researcher");

  const unlabeled = new Agent("id2", baseConfig, { agent: "helper" }, { prompt: "work" });
  assert.equal(Object.prototype.hasOwnProperty.call(unlabeled.toView(), "label"), false);
});

test("Agent.startResume keeps the stored label when omitted and overwrites it when provided", () => {
  const session = { subscribe: () => () => {}, abort: () => {} };
  const agent = new Agent("id", { ...baseConfig, resumable: true }, { agent: "helper" }, { prompt: "work", label: "researcher" });
  agent.attach(session as any);
  completedRun(agent, "done");

  const updates: string[] = [];
  agent.on((_a, kind) => updates.push(kind));
  assert.equal(agent.label, "researcher");

  agent.startResume({ prompt: "follow-up" });
  assert.equal(agent.label, "researcher");
  completedRun(agent, "done again", true);

  agent.startResume({ prompt: "follow-up", label: "renamed", resumable: false });
  assert.equal(agent.label, "renamed");
  assert.equal(agent.resumableOverride, false);
  assert.deepEqual(updates, ["status", "status", "status"]);
});

test("agent re-subscribes on resume so events during a resumed cycle update its state", () => {
  let emit: ((event: any) => void) | undefined;
  const session = {
    messages: [],
    subscribe(handler: any) { emit = handler; return () => { emit = undefined; }; },
    prompt: async () => {},
    abort: () => {},
  };
  const agent = new Agent("id", { ...baseConfig, resumable: true }, { agent: "a" }, { prompt: "p" });

  agent.attach(session as any);
  const firstEmit = emit;
  assert.ok(firstEmit);
  firstEmit({ type: "turn_end" });
  assert.equal(agent.toView().activity.turns, 1);
  completedRun(agent, "done");
  assert.equal(emit, undefined, "subscription should be torn down on complete");

  agent.startResume({ prompt: "p2" });
  agent.attach(session as any);
  const resumedEmit = emit as ((event: any) => void) | undefined;
  assert.ok(resumedEmit, "resume should re-subscribe");
  resumedEmit({ type: "turn_end" });
  resumedEmit({ type: "tool_execution_start", toolName: "read" });
  const resumedActivity = agent.toView().activity;
  assert.equal(resumedActivity.turns, 2);
  assert.equal(resumedActivity.toolHistory.length, 1);
  completedRun(agent, "done2");
  assert.equal(emit, undefined, "subscription should be torn down on complete after resume");
});

test("agent stores tool-use history and keeps active tool correct for overlapping executions", () => {
  let sessionEmit: ((event: any) => void) | undefined;
  const session = {
    messages: [],
    subscribe(handler: any) { sessionEmit = handler; return () => { sessionEmit = undefined; }; },
    prompt: async () => {},
    abort: () => {},
  };
  const agent = new Agent("id", baseConfig, { agent: "a" }, { prompt: "p" });

  const activeNames = () =>
    agent.toView().activity.toolHistory.filter(t => t.completedAt === undefined).map(t => t.name);

  agent.attach(session as any);
  assert.ok(sessionEmit);
  sessionEmit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
  sessionEmit({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash" });
  assert.deepEqual(activeNames(), ["read", "bash"]);

  sessionEmit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false });
  const finalHistory = agent.toView().activity.toolHistory;
  assert.deepEqual(activeNames(), ["bash"]);
  assert.equal(finalHistory.length, 2);
  assert.deepEqual(
    finalHistory.map(tool => [tool.id, tool.name, Boolean(tool.completedAt), tool.isError]),
    [
      ["read-1", "read", true, false],
      ["bash-1", "bash", false, undefined],
    ],
  );
});

test("Agent.abort on a running agent aborts the underlying session and finalizes as aborted", async () => {
  let abortCalls = 0;
  const session = { messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => { abortCalls += 1; } };
  const agent = new Agent("id", baseConfig, { agent: "helper" }, { prompt: "p" });
  agent.attach(session as any);

  await agent.abort();

  assert.equal(abortCalls, 1);
  assert.equal(doneStatus(agent).result.status, "aborted");
});

test("Agent.abort on a queued agent finalizes as skipped without touching a session", async () => {
  const agent = new Agent("id", baseConfig, { agent: "helper" }, { prompt: "p" });
  assert.equal(agent.status.kind, "queued");

  await agent.abort();

  assert.equal(doneStatus(agent).result.status, "skipped");
});

test("Agent.abort on a terminal agent is a no-op and does not re-finalize", async () => {
  let abortCalls = 0;
  const session = { messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => { abortCalls += 1; } };
  const agent = new Agent("id", baseConfig, { agent: "helper" }, { prompt: "p" });
  agent.attach(session as any);
  const firstResult = completedRun(agent, "done");
  doneStatus(agent);

  await agent.abort();

  assert.equal(abortCalls, 0);
  assert.equal(doneStatus(agent).result, firstResult);
});
