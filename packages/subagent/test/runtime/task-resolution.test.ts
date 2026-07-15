import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent } from "../../src/domain/agent.js";
import { resolveTask } from "../../src/runtime/task-resolution.js";

const noop = () => {};

function assertCurrentSnapshotFields(snapshot: Record<string, unknown>): void {
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "resumed"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "previousRuns"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "effectiveConfig"), false);
}

test("preflight failures project current snapshot fields for unknown tasks", () => {
  const realNow = Date.now;
  Date.now = () => 1_000;
  try {
    const registry = { agents: new Map() } as any;
    const unknownSpawn = resolveTask({
      task: { kind: "spawn", agent: "missing", prompt: "spawn prompt", label: "spawn label", model: "m/x", thinking: "high", skills: [] },
      background: true,
      groupId: "group",
      inputIndex: 3,
      registry,
      findAgent: () => undefined,
      listener: noop,
    });
    const unknownResume = resolveTask({
      task: { kind: "resume", sessionId: "ghost", prompt: "resume prompt" },
      background: false,
      groupId: "group",
      inputIndex: 4,
      registry,
      findAgent: () => undefined,
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
      dispatch: "background",
      retention: "transient",
      config: {
        name: "missing",
        description: "",
        source: undefined,
        sourcePath: undefined,
        model: "m/x",
        thinking: "high",
        tools: undefined,
        skills: [],
        resumable: false,
      },
      status: {
        kind: "done",
        outcome: "error",
        completedAt: 1_000,
        resumed: false,
        error: "Unknown agent: missing. Available agents:\n",
      },
      activity: { turns: 0, compactions: 0, toolHistory: [] },
      usage: undefined,
      capabilities: { canResume: false, canRemove: false, canClear: false },
    });
    assert.deepEqual(unknownResume.failure, {
      id: "group:resume-4",
      inputIndex: 4,
      prompt: "resume prompt",
      createdAt: 1_000,
      dispatch: "foreground",
      retention: "transient",
      config: {
        name: "(unknown)",
        description: "",
        source: undefined,
        sourcePath: undefined,
        model: undefined,
        thinking: undefined,
        tools: undefined,
        resumable: false,
      },
      status: {
        kind: "done",
        outcome: "error",
        completedAt: 1_000,
        resumed: true,
        error: "Unknown resumable subagent session: ghost",
      },
      activity: { turns: 0, compactions: 0, toolHistory: [] },
      usage: undefined,
      capabilities: { canResume: false, canRemove: false, canClear: false },
    });
    assertCurrentSnapshotFields(unknownSpawn.failure as unknown as Record<string, unknown>);
    assertCurrentSnapshotFields(unknownResume.failure as unknown as Record<string, unknown>);
  } finally {
    Date.now = realNow;
  }
});

test("blocked known resumes project target config and preserve synthetic row fields", () => {
  const realNow = Date.now;
  Date.now = () => 1_000;
  try {
    const config = {
      name: "known",
      description: "Known agent",
      systemPrompt: "system",
      source: "user" as const,
      sourcePath: "/agents/known.md",
      model: "default/model",
      thinking: "low" as const,
      tools: ["read"],
      skills: ["skill-a"],
      resumable: true,
    };
    const target = new Agent(
      "session-1",
      config,
      { kind: "spawn", agent: "known", prompt: "original", label: "original label", model: "override/model", thinking: "high", skills: ["requested-skill"] },
      noop,
    );
    const result = resolveTask({
      task: { kind: "resume", sessionId: target.id, prompt: "blocked", label: "new label" },
      background: true,
      groupId: "group",
      inputIndex: 5,
      registry: { agents: new Map([["known", config]]) } as any,
      findAgent: id => id === target.id ? target : undefined,
      listener: noop,
    });

    assert.equal(result.kind, "failure");
    if (result.kind !== "failure") return;
    assert.deepEqual(result.failure, {
      id: "session-1",
      inputIndex: 5,
      label: "new label",
      prompt: "blocked",
      createdAt: 1_000,
      dispatch: "background",
      retention: "transient",
      config: {
        name: "known",
        description: "Known agent",
        source: "user",
        sourcePath: "/agents/known.md",
        model: "override/model",
        thinking: "high",
        tools: ["read"],
        skills: ["requested-skill"],
        resumable: true,
      },
      status: {
        kind: "done",
        outcome: "error",
        completedAt: 1_000,
        resumed: true,
        error: "Cannot resume subagent session session-1: it is already resuming.",
      },
      activity: { turns: 0, compactions: 0, toolHistory: [] },
      usage: undefined,
      capabilities: { canResume: false, canRemove: false, canClear: false },
    });
    assertCurrentSnapshotFields(result.failure as unknown as Record<string, unknown>);
  } finally {
    Date.now = realNow;
  }
});
