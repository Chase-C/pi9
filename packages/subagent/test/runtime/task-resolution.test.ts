import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent } from "../../src/domain/agent.js";
import { resolveTask } from "../../src/runtime/task-resolution.js";
import type { SpawnRequest } from "../../src/schema.js";

const noop = () => {};
const allocateSessionId = () => "test-session";

function assertNoLifecycleAliases(value: object): void {
  for (const alias of ["resumable", "resumed", "canClear"])
    assert.equal(Object.prototype.hasOwnProperty.call(value, alias), false);
}

test("task resolution reports session ID exhaustion without creating an Agent", () => {
  const config = { name: "known", description: "", systemPrompt: "", source: "project" };
  const result = resolveTask({
    task: { kind: "spawn", agent: "known", prompt: "work" },
    dispatch: "foreground",
    groupId: "group",
    inputIndex: 0,
    registry: { agents: new Map([["known", config]]) } as any,
    findAgent: () => undefined,
    allocateSessionId: () => undefined,
    listener: noop,
  });

  assert.equal(result.kind, "failure");
  if (result.kind !== "failure") return;
  assert.equal("agent" in result, false);
  assert.deepEqual(result.failure.attempt, { kind: "spawn", dispatch: "foreground" });
  assert.equal(result.failure.status.kind, "done");
  if (result.failure.status.kind === "done")
    assert.equal(result.failure.status.error, "Subagent session ID space exhausted.");
});

test("unknown preflight failures use canonical spawn and resume snapshots", () => {
  const realNow = Date.now;
  Date.now = () => 1_000;
  try {
    const registry = { agents: new Map() } as any;
    const unknownSpawn = resolveTask({
      task: {
        kind: "spawn",
        agent: "missing",
        prompt: "spawn prompt",
        label: "spawn label",
        model: "m/x",
        thinking: "high",
        skills: [],
        retainConversation: true,
      },
      dispatch: "background",
      groupId: "group",
      inputIndex: 3,
      registry,
      findAgent: () => undefined,
      allocateSessionId,
      listener: noop,
    });
    const unknownResume = resolveTask({
      task: { kind: "resume", sessionId: "ghost", prompt: "resume prompt" },
      dispatch: "foreground",
      groupId: "group",
      inputIndex: 4,
      registry,
      findAgent: () => undefined,
      allocateSessionId,
      listener: noop,
    });

    assert.equal(unknownSpawn.kind, "failure");
    assert.equal(unknownResume.kind, "failure");
    if (unknownSpawn.kind !== "failure" || unknownResume.kind !== "failure") return;

    assert.deepEqual(unknownSpawn.failure, {
      id: "group:resume-3",
      inputIndex: 3,
      label: "spawn label",
      prompt: "spawn prompt",
      createdAt: 1_000,
      attempt: { kind: "spawn", dispatch: "background" },
      conversation: { policy: "retain", available: false },
      retention: { catalog: "transient", reasons: [] },
      config: {
        name: "missing",
        description: "",
        source: undefined,
        sourcePath: undefined,
        model: "m/x",
        thinking: "high",
        tools: undefined,
        skills: [],
      },
      status: {
        kind: "done",
        outcome: "error",
        completedAt: 1_000,
        error: "Unknown agent: missing. Available agents:\n",
      },
      activity: { turns: 0, compactions: 0, toolHistory: [] },
      usage: undefined,
      capabilities: { canResume: false, canRemove: false },
    });
    assert.deepEqual(unknownResume.failure, {
      id: "group:resume-4",
      inputIndex: 4,
      prompt: "resume prompt",
      createdAt: 1_000,
      attempt: { kind: "resume", dispatch: "foreground" },
      conversation: { policy: "release", available: false },
      retention: { catalog: "transient", reasons: [] },
      config: {
        name: "(unknown)",
        description: "",
        source: undefined,
        sourcePath: undefined,
        model: undefined,
        thinking: undefined,
        tools: undefined,
      },
      status: {
        kind: "done",
        outcome: "error",
        completedAt: 1_000,
        error: "Unknown retained subagent session: ghost",
      },
      activity: { turns: 0, compactions: 0, toolHistory: [] },
      usage: undefined,
      capabilities: { canResume: false, canRemove: false },
    });
    for (const failure of [unknownSpawn.failure, unknownResume.failure]) {
      assertNoLifecycleAliases(failure);
      assertNoLifecycleAliases(failure.config);
      assertNoLifecycleAliases(failure.status);
      assertNoLifecycleAliases(failure.capabilities);
    }
  } finally {
    Date.now = realNow;
  }
});

test("a blocked known resume preserves the spawn label and resolved conversation policy", () => {
  const realNow = Date.now;
  Date.now = () => 1_000;
  try {
    const config = {
      name: "known",
      description: "Known agent",
      systemPrompt: "system",
      source: "user" as const,
      sourcePath: "/agents/known.md",
      retainConversation: true,
      model: "default/model",
      thinking: "low" as const,
      tools: ["read"],
      skills: ["skill-a"],
    };
    const spawn: SpawnRequest = {
      kind: "spawn",
      agent: "known",
      prompt: "original",
      label: "original label",
      model: "override/model",
      thinking: "high",
      skills: ["requested-skill"],
    };
    const target = new Agent("session-1", config, spawn, noop);
    spawn.label = "mutated label";
    assert.equal(target.requestedConfig.conversationPolicy, "retain");

    const result = resolveTask({
      task: { kind: "resume", sessionId: target.id, prompt: "blocked" },
      dispatch: "background",
      groupId: "group",
      inputIndex: 5,
      registry: { agents: new Map([["known", config]]) } as any,
      findAgent: id => id === target.id ? target : undefined,
      allocateSessionId,
      listener: noop,
    });

    assert.equal(result.kind, "failure");
    if (result.kind !== "failure") return;
    assert.deepEqual(result.failure, {
      id: "session-1",
      inputIndex: 5,
      label: "original label",
      prompt: "blocked",
      createdAt: 1_000,
      attempt: { kind: "resume", dispatch: "background" },
      conversation: { policy: "retain", available: false },
      retention: { catalog: "transient", reasons: [] },
      config: {
        name: "known",
        description: "Known agent",
        source: "user",
        sourcePath: "/agents/known.md",
        model: "override/model",
        thinking: "high",
        tools: ["read"],
        skills: ["requested-skill"],
      },
      status: {
        kind: "done",
        outcome: "error",
        completedAt: 1_000,
        error: "Cannot resume subagent session session-1: it is already resuming.",
      },
      activity: { turns: 0, compactions: 0, toolHistory: [] },
      usage: undefined,
      capabilities: { canResume: false, canRemove: false },
    });
  } finally {
    Date.now = realNow;
  }
});
