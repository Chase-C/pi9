import { test, expect } from "vitest";
import { projectSubagentRunIndex } from "../../src/runtime/session-metadata.js";

const sentinel = "SENSITIVE_SENTINEL_" + "x".repeat(10_000);

function snapshot(outcome: "completed" | "error") {
  return {
    conversationId: "amber-acorn",
    label: "safe label",
    config: { name: "helper" },
    runs: [{
      runId: "adapt-ably",
      kind: "spawn",
      prompt: `prompt:${sentinel}`,
      status: {
        kind: "done",
        outcome,
        startedAt: 100,
        completedAt: 175,
        output: `output:${sentinel}`,
        error: `error:${sentinel}`,
      },
    }],
  } as any;
}

test.each(["completed", "error"] as const)("durable metadata excludes full content for %s runs", outcome => {
  const metadata = projectSubagentRunIndex(snapshot(outcome));
  expect(metadata).toEqual({
    version: 2,
    conversationId: "amber-acorn",
    runId: "adapt-ably",
    agent: "helper",
    label: "safe label",
    kind: "spawn",
    status: outcome,
    completedAt: 175,
    startedAt: 100,
    elapsedMs: 75,
  });
  const persisted = JSON.stringify(metadata);
  expect(persisted).not.toContain("SENSITIVE_SENTINEL");
  expect(persisted).not.toContain("prompt:");
  expect(persisted).not.toContain("output:");
  expect(persisted).not.toContain("error:");
});
