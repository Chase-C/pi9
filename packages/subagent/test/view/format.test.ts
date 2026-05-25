import { test } from "vitest";
import assert from "node:assert/strict";

import {
  backgroundStartedDetails,
  formatSubagentSessionInspect,
  formatSubagentSessionSummary,
  formatSubagentToolLines,
  formatWidgetLines,
  inventoryDetails,
  resultsDetails,
  runDetails,
  runSummary,
} from "../../src/view/format.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("subagent run display animates only the running status glyph", () => {
  const sessions = [
    fakeAgent({ config: { name: "done" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }),
    fakeAgent({ config: { name: "active" }, status: { kind: "running", startedAt: 1 } }),
    fakeAgent({ config: { name: "waiting" }, status: { kind: "queued" } }),
    fakeAgent({ config: { name: "failed" }, status: { kind: "error", startedAt: 1, completedAt: 2, error: "bad" } }),
  ];

  const details = runDetails(sessions);
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

test("the dispatch:background segment surfaces in both inspect summary and inventory line formatters", () => {
  const retained = fakeAgent({ config: { name: "helper", resumable: true }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } });
  const background = fakeAgent({ id: "s2", dispatch: "background", config: { name: "helper", resumable: true }, status: { kind: "running", startedAt: 1 } });

  // formatSubagentSessionSummary (inspect view)
  assert.doesNotMatch(formatSubagentSessionSummary(retained), /dispatch:/);
  assert.match(formatSubagentSessionSummary(background), /dispatch:background/);

  // formatSubagentToolLines (inventory view)
  assert.doesNotMatch(formatSubagentToolLines(inventoryDetails([retained]), false, 0).join("\n"), /dispatch:/);
  assert.match(formatSubagentToolLines(inventoryDetails([background]), false, 0).join("\n"), /dispatch:background/);
});

test("background-started view collapsed line shows total count", () => {
  const sessions = [
    fakeAgent({ id: "s1", dispatch: "background", config: { name: "scout" }, status: { kind: "queued" } }),
    fakeAgent({ id: "s2", dispatch: "background", config: { name: "scout" }, status: { kind: "running", startedAt: 1 } }),
    fakeAgent({ id: "s3", dispatch: "background", config: { name: "reviewer" }, status: { kind: "queued" } }),
  ];

  const collapsed = formatSubagentToolLines(backgroundStartedDetails(sessions), false, 0);
  assert.deepEqual(collapsed, ["3 background subagents started"]);
});

test("background-started view expanded shows one line per session with session id and label when present", () => {
  const sessions = [
    fakeAgent({ id: "scout-1", dispatch: "background", config: { name: "scout" }, label: "frontend auth", status: { kind: "queued" } }),
    fakeAgent({ id: "rev-1", dispatch: "background", config: { name: "reviewer" }, status: { kind: "running", startedAt: 1 } }),
  ];

  const expanded = formatSubagentToolLines(backgroundStartedDetails(sessions), true, 0).join("\n");
  assert.match(expanded, /frontend auth · scout-1/);
  assert.match(expanded, /rev-1/);
  assert.doesNotMatch(expanded, /reviewer/);
  assert.doesNotMatch(expanded, /queued/);
  assert.doesNotMatch(expanded, /running/);
});

test("results view collapsed shows count summary by outcome status", () => {
  const details = resultsDetails([
    { snapshot: fakeAgent({ id: "s1", config: { name: "helper" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }) },
    { snapshot: fakeAgent({ id: "s2", config: { name: "flaky" }, status: { kind: "error", startedAt: 1, completedAt: 2, error: "boom" } }) },
    { snapshot: fakeAgent({ id: "s3", config: { name: "stop" }, status: { kind: "aborted", startedAt: 1, completedAt: 2, error: "Agent aborted." } }) },
  ]);
  const joined = formatSubagentToolLines(details, false, 0).join("\n");
  assert.match(joined, /3 results/);
  assert.match(joined, /1 completed/);
  assert.match(joined, /1 error/);
  assert.match(joined, /1 aborted/);
});

test("results view expanded shows agent, status, snippet, and session handle when resumable", () => {
  const details = resultsDetails([
    { snapshot: fakeAgent({
      id: "sess-1", label: "phase 1", config: { name: "helper", resumable: true },
      status: { kind: "completed", startedAt: 1, completedAt: 2, response: "all done", resumed: true },
    }) },
    { snapshot: fakeAgent({ id: "flaky-1", config: { name: "flaky" }, status: { kind: "error", startedAt: 1, completedAt: 2, error: "boom" } }) },
  ]);
  const expanded = formatSubagentToolLines(details, true, 0).join("\n");
  assert.match(expanded, /helper/);
  assert.match(expanded, /phase 1/);
  assert.match(expanded, /completed/);
  assert.match(expanded, /Result: all done/);
  assert.match(expanded, /session:sess-1/);
  assert.match(expanded, /resumed/);
  assert.match(expanded, /flaky/);
  assert.match(expanded, /error/);
  assert.match(expanded, /Error: boom/);
});

test("background-started details project collectable handles with sessionId and optional label", () => {
  const sessions = [
    fakeAgent({ id: "a", dispatch: "background", config: { name: "scout" }, inputIndex: 0, label: "alpha", status: { kind: "queued" } }),
    fakeAgent({ id: "preflight", dispatch: "background", retention: "transient", config: { name: "missing" }, inputIndex: 1, status: { kind: "error", error: "Unknown agent" } }),
    fakeAgent({ id: "b", dispatch: "background", config: { name: "reviewer" }, inputIndex: 2, status: { kind: "queued" } }),
  ];

  const details = backgroundStartedDetails(sessions);
  assert.equal(details.view, "background-started");
  assert.equal(details.count, 2);
  assert.deepEqual(details.handles, [
    { sessionId: "a", label: "alpha" },
    { sessionId: "b" },
  ]);
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

test("formatWidgetLines includes persistent terminal rows even when they are not resumable", () => {
  const foregroundResumable = fakeAgent({ id: "fg", config: { name: "foreground", resumable: true }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } });
  const backgroundOneshot = fakeAgent({ id: "bg", dispatch: "background", retention: "persistent", config: { name: "background", resumable: false }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } });
  const transient = fakeAgent({ id: "tmp", retention: "transient", config: { name: "transient", resumable: false }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } });

  const lines = formatWidgetLines([foregroundResumable, backgroundOneshot, transient], 1_000);

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^foreground /);
  assert.match(lines[1], /^background /);
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

test("subagent run renders the flat batch shape and ignores parentSessionId when details.subtree is absent", () => {
  const root = fakeAgent({ id: "r", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  // A second batch session that happens to declare a parent — should NOT be indented in run rendering.
  const sibling = fakeAgent({ id: "s", parentSessionId: "r", config: { name: "sibling" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });

  const details = runDetails([root, sibling]);
  const lines = formatSubagentToolLines(details, false, 0);

  assert.match(lines[0], /^  ⠋ root/);
  assert.match(lines[1], /^  ⠋ sibling/);
});

test("subagent run renders details.subtree as a depth-indented tree when present", () => {
  const root = fakeAgent({ id: "r", config: { name: "alpha" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const child = fakeAgent({ id: "c", parentSessionId: "r", config: { name: "beta" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });
  const grand = fakeAgent({ id: "g", parentSessionId: "c", config: { name: "gamma" }, createdAt: 3, status: { kind: "running", startedAt: 1 } });

  const details = runDetails([root], { subtree: [root, child, grand] });
  const lines = formatSubagentToolLines(details, false, 0);

  assert.equal(lines.length, 3);
  assert.match(lines[0], /^  ⠋ alpha/);
  assert.match(lines[1], /^    ⠋ beta/);
  assert.match(lines[2], /^      ⠋ gamma/);
});

test("collapsed subagent run rows show three recent rich tool lines below the session row", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    status: { kind: "running", startedAt: 1_000 },
    turns: 2,
    activity: { toolHistory: [
      { id: "old", name: "ls", inputSummary: "packages", startedAt: 2_000, completedAt: 3_000 },
      { id: "read", name: "read", inputSummary: "packages/subagent/src/view/tool-result-lines.ts", startedAt: 4_000, completedAt: 4_500 },
      { id: "grep", name: "grep", inputSummary: '"formatRunSessionLine" in packages/subagent/src', startedAt: 5_000, completedAt: 6_000 },
      { id: "bash", name: "bash", inputSummary: "npm test --workspace=@pi9/subagent", startedAt: 7_000 },
    ] },
  });

  const lines = formatSubagentToolLines(runDetails([session]), false, 19_000);

  assert.equal(lines.length, 4);
  assert.equal(lines[0], "  ⠇ reviewer · 2 turns · 0 tokens · 18s");
  assert.equal(lines[1], "    ✓ read packages/subagent/src/view/tool-result-lines.ts · 0s");
  assert.equal(lines[2], '    ✓ grep "formatRunSessionLine" in packages/subagent/src · 1s');
  assert.equal(lines[3], "    ⠇ bash npm test --workspace=@pi9/subagent · 12s");
});

test("collapsed subagent run row shows only the active subagent tool line when present", () => {
  const parent = fakeAgent({
    id: "parent",
    config: { name: "parent" },
    status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory: [
      { id: "read", name: "read", inputSummary: "README.md", startedAt: 2_000, completedAt: 3_000 },
      { id: "sub", name: "subagent", inputSummary: "run 2 tasks", startedAt: 4_000 },
    ] },
  });
  const child = fakeAgent({ id: "child", parentSessionId: "parent", config: { name: "child" }, status: { kind: "running", startedAt: 5_000 } });

  const lines = formatSubagentToolLines(runDetails([parent], { subtree: [parent, child] }), false, 10_000);

  assert.deepEqual(lines, [
    "  ⠸ parent · 0 turns · 0 tokens · 9s",
    "    ⠸ subagent run 2 tasks · 6s",
    "    ⠸ child · 0 turns · 0 tokens · 5s",
  ]);
});

test("expanded subagent run renders the prompt and each current-run tool as a rich line below it", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    label: "auth review",
    prompt: "Review the auth changes and summarize risks.",
    status: { kind: "running", startedAt: 1_000 },
    turns: 2,
    activity: { toolHistory: [
      { id: "read", name: "read", inputSummary: "packages/subagent/src/view/tool-result-lines.ts", startedAt: 4_000, completedAt: 4_500 },
      { id: "bash", name: "bash", inputSummary: "npm test --workspace=@pi9/subagent", startedAt: 7_000, completedAt: 10_000 },
      { id: "edit", name: "edit", inputSummary: "packages/subagent/src/view/session-lines.ts", startedAt: 11_000 },
    ] },
  });

  const lines = formatSubagentToolLines(runDetails([session]), true, 15_000);

  // Prompt still renders below the head row.
  assert.match(lines.join("\n"), /Review the auth changes and summarize risks\./);

  // Tools section header plus one rich line per tool, chronological with newest at the bottom.
  const toolsIdx = lines.findIndex(line => line === "    Tools:");
  assert.notEqual(toolsIdx, -1);
  assert.equal(lines[toolsIdx + 1], "      ✓ read packages/subagent/src/view/tool-result-lines.ts · 0s");
  assert.equal(lines[toolsIdx + 2], "      ✓ bash npm test --workspace=@pi9/subagent · 3s");
  assert.equal(lines[toolsIdx + 3], "      ⠴ edit packages/subagent/src/view/session-lines.ts · 4s");
});

test("expanded subagent run no longer renders the aggregate tool-count line", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory: [
      { id: "r1", name: "read", inputSummary: "a.ts", startedAt: 2_000, completedAt: 2_500 },
      { id: "r2", name: "read", inputSummary: "b.ts", startedAt: 3_000, completedAt: 3_500 },
      { id: "r3", name: "read", inputSummary: "c.ts", startedAt: 4_000, completedAt: 4_500 },
      { id: "b1", name: "bash", inputSummary: "ls", startedAt: 5_000, completedAt: 5_500 },
    ] },
  });

  const joined = formatSubagentToolLines(runDetails([session]), true, 10_000).join("\n");

  assert.doesNotMatch(joined, /read ×3/);
  assert.doesNotMatch(joined, /×/);
});

test("expanded subagent run renders every tool call, not just the most recent three", () => {
  const toolHistory = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`,
    name: "read",
    inputSummary: `file-${i}.ts`,
    startedAt: 2_000 + i * 1_000,
    completedAt: 2_500 + i * 1_000,
  }));
  const session = fakeAgent({
    config: { name: "reviewer" },
    status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory },
  });

  const lines = formatSubagentToolLines(runDetails([session]), true, 20_000);
  const toolLines = lines.filter(line => /^      ✓ read file-\d\.ts/.test(line));

  assert.equal(toolLines.length, 5);
  assert.match(toolLines[0], /file-0\.ts/);
  assert.match(toolLines[4], /file-4\.ts/);
});

test("expanded subagent run keeps the result snippet for a terminal row, after prompt and tools", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    prompt: "Summarize the risks.",
    status: { kind: "completed", startedAt: 1_000, completedAt: 8_000, response: "Found two issues." },
    activity: { toolHistory: [
      { id: "read", name: "read", inputSummary: "auth.ts", startedAt: 2_000, completedAt: 2_500 },
      { id: "bash", name: "bash", inputSummary: "npm test", startedAt: 3_000, completedAt: 5_000 },
    ] },
  });

  const lines = formatSubagentToolLines(runDetails([session]), true, 8_000);
  const joined = lines.join("\n");

  assert.match(joined, /Summarize the risks\./);
  const toolsIdx = lines.findIndex(line => line === "    Tools:");
  assert.notEqual(toolsIdx, -1);
  assert.equal(lines[toolsIdx + 1], "      ✓ read auth.ts · 0s");
  assert.equal(lines[toolsIdx + 2], "      ✓ bash npm test · 2s");

  const resultIdx = lines.findIndex(line => /Result: Found two issues\./.test(line));
  assert.ok(resultIdx > toolsIdx, "result snippet should follow the tools section");
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

test("runSummary elapsed measures wall-clock from the parent run start, not summed child runtime", () => {
  // Two children that each ran 30s but overlapped: summed runtime is 60s, wall clock is 40s.
  const a = fakeAgent({ id: "a", status: { kind: "completed", startedAt: 11_000, completedAt: 41_000 } });
  const b = fakeAgent({ id: "b", status: { kind: "completed", startedAt: 15_000, completedAt: 45_000 } });

  const summary = runSummary(runDetails([a, b], { runStartedAt: 1_000 }), 41_000);

  assert.equal(summary?.elapsed, "40s");
});

// Regression: queued time before the first session starts still counts toward the title elapsed.
// The title should not reset to 0s when the first worker transitions queued -> running.
test("runSummary elapsed includes queue time before the first session starts", () => {
  const active = fakeAgent({ id: "a", status: { kind: "running", startedAt: 31_000 } });

  const summary = runSummary(runDetails([active], { runStartedAt: 1_000 }), 41_000);

  assert.equal(summary?.elapsed, "40s");
});

test("runSummary counts the subtree (including nested children) when present, not the flat sessions", () => {
  const root = fakeAgent({ id: "r", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const child = fakeAgent({ id: "c", parentSessionId: "r", config: { name: "child" }, createdAt: 2, status: { kind: "queued" } });
  const grandchild = fakeAgent({ id: "g", parentSessionId: "c", config: { name: "grand" }, createdAt: 3, status: { kind: "completed", startedAt: 2, completedAt: 3 } });

  const summary = runSummary(runDetails([root], { subtree: [root, child, grandchild] }), 10_000);

  assert.deepEqual(
    { running: summary?.running, queued: summary?.queued, finished: summary?.finished },
    { running: 1, queued: 1, finished: 1 },
  );
});
