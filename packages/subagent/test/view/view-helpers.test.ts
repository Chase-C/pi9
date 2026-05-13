import { test } from "vitest";
import assert from "node:assert/strict";

import { canResumeSubagentSession } from "../../src/view/view-helpers.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("canResumeSubagentSession allows completed sessions and retryable pre-attach resume failures", () => {
  assert.equal(canResumeSubagentSession(fakeAgent({ config: { resumable: true } })), true);
  assert.equal(canResumeSubagentSession(fakeAgent({ config: { resumable: false } })), false);
  assert.equal(canResumeSubagentSession(fakeAgent({ config: { resumable: true }, status: { kind: "error", completedAt: 2, error: "resume setup failed", session: {} } })), true);
  assert.equal(canResumeSubagentSession(fakeAgent({ config: { resumable: true }, status: { kind: "skipped", skippedAt: 2, error: "Agent skipped.", session: {} } })), true);

  const nonResumableStatuses = [
    { kind: "queued" as const },
    { kind: "running" as const, startedAt: 1 },
    { kind: "error" as const, startedAt: 1, errorAt: 2, error: "e", session: {} },
    { kind: "aborted" as const, startedAt: 1, abortedAt: 2, session: {} },
    { kind: "interrupted" as const, startedAt: 1, interruptedAt: 2, session: {} },
    { kind: "skipped" as const, skippedAt: 1 },
  ];
  for (const status of nonResumableStatuses) {
    assert.equal(
      canResumeSubagentSession(fakeAgent({ config: { resumable: true }, status })),
      false,
      status.kind,
    );
  }
});
