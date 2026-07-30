import { test, expect } from "vitest";
import { projectSubagentRunIndex } from "../../src/index.js";

const sentinel = "SENSITIVE_SENTINEL_" + "x".repeat(10_000);

function snapshot(outcome: "completed" | "error") {
  return {
    conversationId: "amber-acorn",
    label: "safe label",
    agent: { name: "helper" },
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
    version: 3,
    subagentId: "amber-acorn",
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

test("durable metadata omits optional label and timing for runs that never started", () => {
  const value = snapshot("error");
  delete value.label;
  delete value.runs[0].status.startedAt;

  expect(projectSubagentRunIndex(value)).toEqual({
    version: 3,
    subagentId: "amber-acorn",
    agent: "helper",
    kind: "spawn",
    status: "error",
    completedAt: 175,
  });
});
