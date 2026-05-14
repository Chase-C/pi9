import { test } from "vitest";
import assert from "node:assert/strict";

import {
  backgroundStartedDetails,
  formatSubagentSessionInspect,
  formatSubagentSessionSummary,
  formatSubagentToolLines,
  inventoryDetails,
  runDetails,
} from "../../src/view/format.js";
import { serializeGroup } from "../../src/view/serialize.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("subagent run display animates only the running status glyph", () => {
  const sessions = [
    fakeAgent({ config: { name: "done" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }),
    fakeAgent({ config: { name: "active" }, status: { kind: "running", startedAt: 1 } }),
    fakeAgent({ config: { name: "waiting" }, status: { kind: "queued" } }),
    fakeAgent({ config: { name: "failed" }, status: { kind: "error", startedAt: 1, completedAt: 2, error: "bad" } }),
  ];

  const details = runDetails(serializeGroup(sessions));
  const first = formatSubagentToolLines(details, false, 0);
  const second = formatSubagentToolLines(details, false, 120);

  assert.match(first[0], /^  ✓ done/);
  assert.match(first[1], /^  ⠋ active/);
  assert.match(first[2], /^  ○ waiting/);
  assert.match(first[3], /^  ✗ failed/);
  assert.match(second[0], /^  ✓ done/);
  assert.match(second[1], /^  ⠙ active/);
  assert.match(second[2], /^  ○ waiting/);
  assert.match(second[3], /^  ✗ failed/);
});

test("collapsed inventory group line surfaces a filter:<statuses> segment when a status filter is active", () => {
  const a = fakeAgent({ id: "s1", config: { name: "a" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } });
  const b = fakeAgent({ id: "s2", config: { name: "b" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } });

  const noFilter = formatSubagentToolLines(inventoryDetails([a, b]), false, 0);
  assert.doesNotMatch(noFilter.join("\n"), /filter:/);

  const filtered = formatSubagentToolLines(inventoryDetails([a, b], { status: ["completed", "error"] }), false, 0);
  assert.match(filtered.join("\n"), /· filter:completed,error/);
});

test("queued session elapsed uses queuedAt instead of session createdAt", () => {
  const session = fakeAgent({
    createdAt: 1_000,
    config: { name: "helper" },
    status: { kind: "queued", queuedAt: 10_000 },
  });

  const lines = formatSubagentToolLines(inventoryDetails([session]), false, 11_250);

  assert.match(lines.join("\n"), /1s/);
  assert.doesNotMatch(lines.join("\n"), /10s/);
});

test("the kind:background segment surfaces in both inspect summary and inventory line formatters", () => {
  const retained = fakeAgent({ config: { name: "helper", resumable: true }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } });
  const background = fakeAgent({ id: "s2", kind: "background", config: { name: "helper", resumable: true }, status: { kind: "running", startedAt: 1 } });

  // formatSubagentSessionSummary (inspect view)
  assert.doesNotMatch(formatSubagentSessionSummary(retained), /kind:/);
  assert.match(formatSubagentSessionSummary(background), /kind:background/);

  // formatSubagentToolLines (inventory view)
  assert.doesNotMatch(formatSubagentToolLines(inventoryDetails([retained]), false, 0).join("\n"), /kind:/);
  assert.match(formatSubagentToolLines(inventoryDetails([background]), false, 0).join("\n"), /kind:background/);
});

test("background-started view collapsed line shows count summary by status", () => {
  const sessions = [
    fakeAgent({ id: "s1", kind: "background", config: { name: "scout" }, status: { kind: "queued" } }),
    fakeAgent({ id: "s2", kind: "background", config: { name: "scout" }, status: { kind: "running", startedAt: 1 } }),
    fakeAgent({ id: "s3", kind: "background", config: { name: "reviewer" }, status: { kind: "queued" } }),
  ];

  const collapsed = formatSubagentToolLines(backgroundStartedDetails(sessions), false, 0);
  const joined = collapsed.join("\n");
  assert.match(joined, /3 background subagents started/);
  assert.match(joined, /2 queued/);
  assert.match(joined, /1 running/);
});

test("background-started view expanded shows one line per session with session id and initial status", () => {
  const sessions = [
    fakeAgent({ id: "scout-1", kind: "background", config: { name: "scout" }, label: "frontend auth", status: { kind: "queued" } }),
    fakeAgent({ id: "rev-1", kind: "background", config: { name: "reviewer" }, status: { kind: "running", startedAt: 1 } }),
  ];

  const expanded = formatSubagentToolLines(backgroundStartedDetails(sessions), true, 0).join("\n");
  assert.match(expanded, /frontend auth/);
  assert.match(expanded, /scout-1/);
  assert.match(expanded, /queued/);
  assert.match(expanded, /reviewer/);
  assert.match(expanded, /rev-1/);
  assert.match(expanded, /running/);
});

test("subagent session inspect output uses remove terminology", () => {
  const retainedSession = fakeAgent({
    config: { resumable: true },
    status: { kind: "completed", startedAt: 2_000, completedAt: 5_000, response: "done" },
  });
  const inspectLines = formatSubagentSessionInspect(retainedSession).join("\n");
  assert.match(inspectLines, /Actions: inspect, resume, remove/);
  assert.doesNotMatch(inspectLines, /clear/);
});
