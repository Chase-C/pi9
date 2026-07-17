import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { resolveTask } from "../../src/runtime/task-resolution.js";

const noop: AgentUpdateListener = () => {};
const fakeSession = { subscribe: () => () => {}, abort: () => {} } as any;

const baseConfig = {
  retainConversation: false,
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
};

function assertNoLifecycleAliases(value: object): void {
  for (const alias of ["resumable", "resumed", "canClear"])
    assert.equal(Object.prototype.hasOwnProperty.call(value, alias), false);
}

test("a fresh foreground spawn is active, transient, and has no available conversation", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  const snapshot = agent.snapshot();

  assert.deepEqual(snapshot.attempt, { kind: "spawn", dispatch: "foreground" });
  assert.deepEqual(snapshot.conversation, { policy: "release", available: false });
  assert.deepEqual(snapshot.retention, { catalog: "transient", reasons: ["active"] });
  assertNoLifecycleAliases(snapshot);
  assertNoLifecycleAliases(snapshot.config);
  assertNoLifecycleAliases(snapshot.capabilities);
});

test("a background spawn is persistently cataloged from queued through terminal", () => {
  const agent = new Agent(
    "id",
    baseConfig,
    { kind: "spawn", agent: "helper", prompt: "work" },
    noop,
    { dispatch: "background" },
  );

  assert.deepEqual(agent.snapshot().retention, {
    catalog: "persistent",
    reasons: ["active", "background-result"],
  });
  agent.bindSession(fakeSession);
  assert.deepEqual(agent.snapshot().retention, {
    catalog: "persistent",
    reasons: ["active", "background-result"],
  });
  completedRun(agent, "done");
  assert.deepEqual(agent.snapshot().retention, {
    catalog: "persistent",
    reasons: ["background-result"],
  });
});

test("a retained policy is persistent while queued but only keeps a bound conversation", () => {
  const config = { ...baseConfig, retainConversation: true };
  const agent = new Agent("id", config, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  assert.deepEqual(agent.retentionDecision, {
    cataloged: true,
    catalog: "persistent",
    keepConversation: false,
    conversationAvailable: false,
    canResume: false,
    canRemove: false,
    reasons: ["active", "conversation-policy"],
  });

  agent.bindSession(fakeSession);
  completedRun(agent, "done");
  const snapshot = agent.snapshot();
  assert.deepEqual(snapshot.conversation, { policy: "retain", available: true });
  assert.deepEqual(snapshot.retention, { catalog: "persistent", reasons: ["conversation-policy"] });
  assert.deepEqual(snapshot.capabilities, { canResume: true, canRemove: true });
});

test("a completed release-policy foreground spawn is transient despite its bound session", () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  agent.bindSession(fakeSession);
  completedRun(agent, "done");
  const snapshot = agent.snapshot();

  assert.deepEqual(snapshot.conversation, { policy: "release", available: false });
  assert.deepEqual(snapshot.retention, { catalog: "transient", reasons: [] });
  assert.deepEqual(snapshot.capabilities, { canResume: false, canRemove: false });
});

test("snapshot attempt kind and previous runs identify spawn and resume without aliases", () => {
  const config = { ...baseConfig, retainConversation: true };
  const agent = new Agent("id", config, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  agent.bindSession(fakeSession);
  completedRun(agent, "first");

  const spawnSnapshot = agent.snapshot();
  assert.equal(spawnSnapshot.attempt.kind, "spawn");
  assertNoLifecycleAliases(spawnSnapshot);
  assertNoLifecycleAliases(spawnSnapshot.status);

  const resolved = resolveTask({
    task: { kind: "resume", sessionId: agent.id, prompt: "follow-up" },
    dispatch: "background",
    groupId: "g",
    inputIndex: 0,
    registry: { agents: new Map([["helper", config]]) } as any,
    findAgent: id => id === agent.id ? agent : undefined,
    allocateSessionId: () => "test-session",
    listener: noop,
  });
  if (resolved.kind !== "resume") throw new Error("expected resume");

  const liveSnapshot = resolved.agent.snapshot();
  assert.deepEqual(liveSnapshot.attempt, { kind: "resume", dispatch: "background" });
  assert.deepEqual(liveSnapshot.previousRuns?.[0].attempt, { kind: "spawn", dispatch: "foreground" });
  assertNoLifecycleAliases(liveSnapshot);
  assertNoLifecycleAliases(liveSnapshot.status);

  resolved.agent.bindSession(fakeSession);
  completedRun(resolved.agent, "follow-up");
  assert.deepEqual(resolved.agent.snapshot().attempt, { kind: "resume", dispatch: "background" });
});

test("snapshot preserves raw done output without truncating it", () => {
  const raw = "x".repeat(200);
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  agent.bindSession(fakeSession);
  completedRun(agent, raw);
  const snapshot = agent.snapshot();
  if (snapshot.status.kind !== "done") throw new Error("expected done status");
  assert.equal(snapshot.status.output, raw);
});
