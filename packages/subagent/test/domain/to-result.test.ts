import { test } from "vitest";
import assert from "node:assert/strict";

import { toResult } from "../../src/domain/agent-result.js";
import type { AgentSnapshot } from "../../src/domain/agent-snapshot.js";

function terminalSnapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "id1",
    prompt: "do the work",
    createdAt: 0,
    dispatch: "foreground",
    retention: "persistent",
    config: {
      name: "helper",
      description: "d",
      source: "project",
      model: "anthropic/claude",
      thinking: undefined,
      tools: undefined,
      resumable: true,
    },
    status: { kind: "done", outcome: "completed", startedAt: 100, completedAt: 600, output: "the full output", resumed: false },
    activity: { turns: 3, compactions: 0, toolHistory: [] },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 42, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    capabilities: { canResume: true, canRemove: true, canClear: true },
    ...over,
  };
}

test("toResult projects a completed terminal snapshot into the model-facing result", () => {
  const result = toResult(terminalSnapshot());

  assert.equal(result.agent, "helper");
  assert.equal(result.prompt, "do the work");
  assert.equal(result.status, "completed");
  assert.equal(result.output, "the full output");
  assert.equal(result.error, undefined);
  assert.equal(result.model, "anthropic/claude");
  assert.equal(result.resumable, true);
  assert.equal(result.sessionId, "id1");
  assert.equal(result.resumed, false);
  assert.equal(result.turns, 3);
  assert.equal(result.tokens, 42);
  assert.equal(result.elapsedMs, 500);
});

test("toResult carries error text and omits sessionId for a non-resumable failed run", () => {
  const result = toResult(terminalSnapshot({
    config: { name: "helper", description: "d", source: "project", model: undefined, thinking: undefined, tools: undefined, resumable: false },
    status: { kind: "done", outcome: "error", startedAt: 100, completedAt: 200, error: "it blew up", resumed: true },
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "it blew up");
  assert.equal(result.output, undefined);
  assert.equal(result.resumable, false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "sessionId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "model"), false);
  assert.equal(result.resumed, true);
});

test("toResult reports zero elapsed and zero tokens for a pre-attach failure with no startedAt", () => {
  const result = toResult(terminalSnapshot({
    status: { kind: "done", outcome: "skipped", completedAt: 900, error: "Agent skipped.", resumed: false },
    usage: undefined,
    activity: { turns: 0, compactions: 0, toolHistory: [] },
  }));

  assert.equal(result.elapsedMs, 0);
  assert.equal(result.tokens, 0);
  assert.equal(result.turns, 0);
  assert.equal(result.error, "Agent skipped.");
});
