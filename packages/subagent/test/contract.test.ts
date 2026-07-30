import assert from "node:assert/strict";
import { test } from "vitest";
import {
  projectAvailableActions,
  projectFailure,
  projectLiveSubagent,
  projectSubagentStatus,
  type LiveSubagentProjectionSource,
} from "../src/contract.js";
import type { RunViewStatus } from "../src/conversation.js";

const statuses: Array<[RunViewStatus, ReturnType<typeof projectSubagentStatus>]> = [
  [{ kind: "queued", queuedAt: 1 }, "queued"],
  [{ kind: "running", startedAt: 2 }, "running"],
  [{ kind: "done", outcome: "completed", completedAt: 3 }, "completed"],
  [{ kind: "done", outcome: "error", completedAt: 3 }, "failed"],
  [{ kind: "done", outcome: "interrupted", completedAt: 3 }, "failed"],
  [{ kind: "done", outcome: "skipped", completedAt: 3 }, "failed"],
  [{ kind: "done", outcome: "aborted", completedAt: 3 }, "cancelled"],
];

const source = (overrides: Partial<LiveSubagentProjectionSource> = {}): LiveSubagentProjectionSource => ({
  subagentId: "amber-acorn" as any,
  label: "contract tests",
  agent: "worker",
  runStatus: { kind: "done", outcome: "completed", completedAt: 3 },
  joined: false,
  directlyOwned: true,
  resumeAllowed: true,
  removableSubtree: true,
  ...overrides,
});

test("every internal run outcome maps to one public status", () => {
  for (const [internal, expected] of statuses) {
    assert.equal(projectSubagentStatus(internal), expected);
  }
});

test("canonical projection includes joined only for finished subagents", () => {
  assert.deepEqual(projectLiveSubagent(source({
    runStatus: { kind: "running", startedAt: 2 },
    joined: true,
    removableSubtree: false,
  })), {
    ok: true,
    subagentId: "amber-acorn",
    label: "contract tests",
    agent: "worker",
    status: "running",
    availableActions: ["steer", "cancel", "inspect", "join"],
  });

  assert.deepEqual(projectLiveSubagent(source({ joined: false })), {
    ok: true,
    subagentId: "amber-acorn",
    label: "contract tests",
    agent: "worker",
    status: "completed",
    joined: false,
    availableActions: ["inspect", "join", "remove"],
  });
  assert.deepEqual(projectLiveSubagent(source({ joined: true })), {
    ok: true,
    subagentId: "amber-acorn",
    label: "contract tests",
    agent: "worker",
    status: "completed",
    joined: true,
    availableActions: ["resume", "inspect", "join", "remove"],
  });
});

test("available actions are caller-relative", () => {
  const active = { kind: "running", startedAt: 2 } as const;
  assert.deepEqual(projectAvailableActions(source({ runStatus: active, directlyOwned: true, removableSubtree: false })), [
    "steer", "cancel", "inspect", "join",
  ], "a root or direct owner can act on its direct child");
  assert.deepEqual(projectAvailableActions(source({ runStatus: active, directlyOwned: false, removableSubtree: false })), [],
    "an ancestor cannot act on a descendant");
});

test("remove is withheld when an inactive root has an active descendant", () => {
  const inactive = source({ joined: true, removableSubtree: false });
  assert.deepEqual(projectAvailableActions(inactive), ["resume", "inspect", "join"]);
  assert.deepEqual(projectAvailableActions({ ...inactive, removableSubtree: true }), ["resume", "inspect", "join", "remove"]);
});

test("resume requires a joined result and runtime authorization", () => {
  assert.equal(projectAvailableActions(source({ joined: false })).includes("resume"), false);
  assert.equal(projectAvailableActions(source({ joined: true, resumeAllowed: false })).includes("resume"), false);
  assert.equal(projectAvailableActions(source({ joined: true, resumeAllowed: true })).includes("resume"), true);
});

test("failed projections identify the failure category and support explicit truncation", () => {
  const error = { kind: "done", outcome: "error", completedAt: 3, error: "provider rejected the request" } as const;
  const interrupted = { kind: "done", outcome: "interrupted", completedAt: 3, error: "session ended" } as const;
  const skipped = { kind: "done", outcome: "skipped", completedAt: 3, error: "no execution slot" } as const;

  assert.equal(projectFailure(error), "Subagent failed: provider rejected the request");
  assert.equal(projectFailure(interrupted), "Subagent was interrupted: session ended");
  assert.equal(projectFailure(skipped), "Subagent execution was skipped: no execution slot");
  assert.equal(projectFailure({ kind: "done", outcome: "completed", completedAt: 3 }), undefined);
  assert.equal(projectFailure(error, { maxLength: 30 }), "Subagent failed:… [truncated]");
  assert.throws(() => projectFailure(error, { maxLength: 5 }), /at least/);
});

test("failed canonical blocks include failure after the canonical fields", () => {
  const projection = projectLiveSubagent(source({
    runStatus: { kind: "done", outcome: "interrupted", completedAt: 3, error: "connection closed" },
    joined: true,
  }));
  assert.deepEqual(Object.keys(projection), [
    "ok", "subagentId", "label", "agent", "status", "joined", "availableActions", "failure",
  ]);
  assert.equal(projection.failure, "Subagent was interrupted: connection closed");
});
