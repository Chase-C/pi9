import { test } from "vitest";
import assert from "node:assert/strict";

import {
  backgroundStartedDetails,
  formatSubagentSessionInspect,
  formatSubagentSessionSummary,
  formatSubagentToolLines,
  formatWidgetLines,
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

test("flat sessions (no parentSessionId) render in caller order with no indentation in widget and inventory", () => {
  const a = fakeAgent({ id: "a", config: { name: "alpha" }, createdAt: 30, status: { kind: "running", startedAt: 1 } });
  const b = fakeAgent({ id: "b", config: { name: "beta" }, createdAt: 10, status: { kind: "running", startedAt: 1 } });
  const orphan = fakeAgent({ id: "c", parentSessionId: "missing-parent", config: { name: "orphan" }, createdAt: 20, status: { kind: "running", startedAt: 1 } });

  const widgetLines = formatWidgetLines([a, b, orphan], 1_000);
  assert.equal(widgetLines.length, 3);
  assert.match(widgetLines[0], /^alpha /);
  assert.match(widgetLines[1], /^beta /);
  assert.match(widgetLines[2], /^orphan /);
  for (const line of widgetLines) assert.doesNotMatch(line, /^ /);

  const inventoryLines = formatSubagentToolLines(inventoryDetails([a, b, orphan]), true, 1_000);
  const headLines = inventoryLines.filter(line => line.includes(" · running "));
  assert.equal(headLines.length, 3);
  assert.match(headLines[0], /^alpha /);
  assert.match(headLines[1], /^beta /);
  assert.match(headLines[2], /^orphan /);
  for (const line of headLines) assert.doesNotMatch(line, /^ /);
});

test("inventory expanded output orders descendants DFS under their parents with depth indent", () => {
  const root = fakeAgent({ id: "r1", config: { name: "alpha" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const root2 = fakeAgent({ id: "r2", config: { name: "delta" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });
  const child = fakeAgent({ id: "c1", parentSessionId: "r1", config: { name: "beta" }, createdAt: 3, status: { kind: "running", startedAt: 1 } });
  const grandchild = fakeAgent({ id: "g1", parentSessionId: "c1", config: { name: "gamma" }, createdAt: 4, status: { kind: "running", startedAt: 1 } });

  const lines = formatSubagentToolLines(inventoryDetails([child, root, grandchild, root2]), true, 1_000);
  const headLines = lines.filter(line => line.includes(" · running "));

  assert.equal(headLines.length, 4);
  assert.match(headLines[0], /^alpha /);
  assert.match(headLines[1], /^  beta /);
  assert.match(headLines[2], /^    gamma /);
  assert.match(headLines[3], /^delta /);
});

test("formatWidgetLines renders a 2-level tree with depth-based indentation", () => {
  const root = fakeAgent({ id: "root", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const childA = fakeAgent({ id: "child-a", parentSessionId: "root", config: { name: "child-a" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });
  const childB = fakeAgent({ id: "child-b", parentSessionId: "root", config: { name: "child-b" }, createdAt: 3, status: { kind: "running", startedAt: 1 } });
  const grandchild = fakeAgent({ id: "grand", parentSessionId: "child-a", config: { name: "grand" }, createdAt: 4, status: { kind: "running", startedAt: 1 } });

  const lines = formatWidgetLines([root, childA, childB, grandchild], 1_000);

  assert.equal(lines.length, 4);
  assert.match(lines[0], /^root /);
  assert.match(lines[1], /^  child-a /);
  assert.match(lines[2], /^    grand /);
  assert.match(lines[3], /^  child-b /);
});

test("inventoryDetails passes parentSessionId through to each session view", () => {
  const root = fakeAgent({ id: "root", createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const child = fakeAgent({ id: "child", parentSessionId: "root", createdAt: 2, status: { kind: "running", startedAt: 1 } });

  const details = inventoryDetails([root, child]);

  assert.equal(details.sessions[0].parentSessionId, undefined);
  assert.equal(details.sessions[1].parentSessionId, "root");
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
