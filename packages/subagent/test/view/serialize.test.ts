import { test } from "vitest";
import assert from "node:assert/strict";

import type { AgentRunStatus } from "../../src/domain/agent-lifecycle.js";
import type { AgentSnapshot } from "../../src/domain/agent-snapshot.js";
import { serializeInventoryForModel } from "../../src/view/serialize.js";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "session",
    createdAt: 1_000,
    config: {
      name: "worker",
      source: "project",
      model: undefined,
      thinking: undefined,
      tools: [],
    },
    status: { kind: "queued", queuedAt: 1_100 },
    activity: {
      messageSnippet: "private progress",
      turns: 3,
      compactions: 1,
      toolHistory: [{ id: "tool-1", name: "read", startedAt: 1_150, inputSummary: "private input" }],
    },
    usage: undefined,
    attempt: { kind: "spawn", dispatch: "background" },
    conversation: { policy: "retain", available: true },
    retention: { catalog: "persistent", reasons: ["conversation-policy"] },
    effectiveConfig: {
      model: "private/model",
      thinking: "high",
      cwd: "/private",
      skills: ["private-skill"],
      tools: ["read"],
    },
    previousRuns: [{
      prompt: "private previous prompt",
      status: { kind: "done", outcome: "completed", startedAt: 500, completedAt: 900, output: "private previous output" },
      activity: { messageSnippet: "private previous activity", turns: 1, compactions: 0, toolHistory: [] },
      usage: undefined,
      attempt: { kind: "spawn", dispatch: "foreground" },
    }],
    prompt: "private prompt",
    capabilities: { canResume: true, canRemove: true },
    ...overrides,
  };
}

function terminalStatus(outcome: AgentRunStatus): AgentSnapshot["status"] {
  return {
    kind: "done",
    outcome,
    startedAt: 1_500,
    completedAt: 1_900,
    ...(outcome === "completed" ? { output: "full output" } : { error: "full error" }),
  };
}

test("serializes a clean lightweight inventory contract with normalized statuses", () => {
  const sessions = [
    snapshot({
      id: "queued-session",
      config: { ...snapshot().config, name: "queued-agent" },
      status: { kind: "queued", queuedAt: 1_200 },
      attempt: { kind: "spawn", dispatch: "foreground" },
      conversation: { policy: "release", available: false },
      retention: { catalog: "transient", reasons: [] },
      capabilities: { canResume: false, canRemove: false },
    }),
    snapshot({
      id: "created-session",
      config: { ...snapshot().config, name: "created-agent" },
      status: { kind: "queued" },
      label: undefined,
      parentSessionId: undefined,
    }),
    snapshot({
      id: "running-session",
      config: { ...snapshot().config, name: "running-agent" },
      status: { kind: "running", startedAt: 1_700 },
      label: undefined,
      parentSessionId: undefined,
    }),
    ...(["completed", "error", "aborted", "interrupted", "skipped"] as AgentRunStatus[]).map((outcome, index) => snapshot({
      id: `terminal-${outcome}`,
      config: { ...snapshot().config, name: `${outcome}-agent` },
      label: index === 0 ? "labeled" : undefined,
      parentSessionId: index === 0 ? "parent-session" : undefined,
      status: terminalStatus(outcome),
    })),
  ];
  const filter = { status: ["completed", "error"] as const };
  const inventory = serializeInventoryForModel(sessions, { status: [...filter.status] });

  assert.deepEqual(inventory.filter, filter);
  assert.deepEqual(inventory.sessions.map(session => session.status), [
    "queued", "queued", "running", "completed", "error", "aborted", "interrupted", "skipped",
  ]);
  assert.deepEqual(inventory.sessions[0], {
    sessionId: "queued-session",
    agent: "queued-agent",
    status: "queued",
    attempt: { kind: "spawn", dispatch: "foreground" },
    conversation: { policy: "release", available: false },
    retention: { catalog: "transient", reasons: [] },
    capabilities: { canResume: false, canRemove: false },
  });
  assert.deepEqual(inventory.sessions[1], {
    sessionId: "created-session",
    agent: "created-agent",
    status: "queued",
    attempt: { kind: "spawn", dispatch: "background" },
    conversation: { policy: "retain", available: true },
    retention: { catalog: "persistent", reasons: ["conversation-policy"] },
    capabilities: { canResume: true, canRemove: true },
  });
  assert.deepEqual(inventory.sessions[2], {
    sessionId: "running-session",
    agent: "running-agent",
    status: "running",
    attempt: { kind: "spawn", dispatch: "background" },
    conversation: { policy: "retain", available: true },
    retention: { catalog: "persistent", reasons: ["conversation-policy"] },
    capabilities: { canResume: true, canRemove: true },
  });
  assert.deepEqual(inventory.sessions[3], {
    sessionId: "terminal-completed",
    agent: "completed-agent",
    label: "labeled",
    parentSessionId: "parent-session",
    status: "completed",
    attempt: { kind: "spawn", dispatch: "background" },
    conversation: { policy: "retain", available: true },
    retention: { catalog: "persistent", reasons: ["conversation-policy"] },
    capabilities: { canResume: true, canRemove: true },
  });

  const forbidden = [
    "id", "prompt", "output", "error", "messageSnippet", "activity", "toolHistory", "usage", "cost",
    "previousRuns", "config", "effectiveConfig", "createdAt", "startedAt", "queuedAt", "completedAt",
    "inputIndex", "elapsedMs",
  ];
  for (const entry of inventory.sessions) {
    for (const field of forbidden) assert.equal(field in entry, false, `${field} leaked into inventory entry`);
  }
  assert.deepEqual(Object.keys(inventory), ["view", "sessions", "filter"]);
});

test("omits absent optional label and parentSessionId fields", () => {
  const entry = serializeInventoryForModel([
    snapshot({ label: undefined, parentSessionId: undefined }),
  ]).sessions[0];

  assert.equal("label" in entry, false);
  assert.equal("parentSessionId" in entry, false);
});
