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
import { fakeAgent, fakeRunSection } from "../helpers/fake-agent.js";

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

test("results view collapsed renders one run-style row per entry, status by glyph, with no count header", () => {
  const details = resultsDetails([
    { snapshot: fakeAgent({ id: "s1", config: { name: "helper" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }) },
    { snapshot: fakeAgent({ id: "s2", config: { name: "flaky" }, status: { kind: "error", startedAt: 1, completedAt: 2, error: "boom" } }) },
    { snapshot: fakeAgent({ id: "s3", config: { name: "stop" }, status: { kind: "aborted", startedAt: 1, completedAt: 2, error: "Agent aborted." } }) },
  ]);
  const lines = formatSubagentToolLines(details, false, 0);

  // One row per subagent, status conveyed by glyph (✓ done, ✗ error, ! other terminal) — like the run view.
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^  ✓ helper /);
  assert.match(lines[1], /^  ✗ flaky /);
  assert.match(lines[2], /^  ! stop /);
  // The header is the tool-call title line, so the body carries no count summary.
  assert.doesNotMatch(lines.join("\n"), /\d results?\b/);
});

test("results view expanded renders each entry as a run-style block with its result snippet", () => {
  const details = resultsDetails([
    { snapshot: fakeAgent({
      id: "sess-1", label: "phase 1", resumed: true, config: { name: "helper", resumable: true },
      status: { kind: "completed", startedAt: 1, completedAt: 2, response: "all done", resumed: true },
    }) },
    { snapshot: fakeAgent({ id: "flaky-1", config: { name: "flaky" }, status: { kind: "error", startedAt: 1, completedAt: 2, error: "boom" } }) },
  ]);
  const expanded = formatSubagentToolLines(details, true, 0).join("\n");
  assert.match(expanded, /✓ helper  phase 1/);
  assert.match(expanded, /resumed/);
  assert.match(expanded, /Result: all done/);
  assert.match(expanded, /✗ flaky/);
  assert.match(expanded, /Error: boom/);
  // Status shows via glyph, not text, and the raw session handle is no longer surfaced in the view.
  assert.doesNotMatch(expanded, /session:/);
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

test("collapsed subagent run rows show the three most recent tools newest-first with an additional-calls tail", () => {
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

  // Newest tool first, capped at three, then a tail line counting the older (4th) call.
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "  ⠇ reviewer · 2 turns · 0 tokens · 18s");
  assert.equal(lines[1], "    ⠇ bash npm test --workspace=@pi9/subagent · 12s");
  assert.equal(lines[2], '    ✓ grep "formatRunSessionLine" in packages/subagent/src · 1s');
  assert.equal(lines[3], "    ✓ read packages/subagent/src/view/tool-result-lines.ts · 0s");
  assert.equal(lines[4], "    +1 additional tool call");
});

test("collapsed subagent run additional-calls tail pluralizes and counts every tool beyond the recent three", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory: Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`, name: "read", inputSummary: `file-${i}.ts`, startedAt: 2_000 + i * 1_000, completedAt: 2_500 + i * 1_000,
    })) },
  });

  const lines = formatSubagentToolLines(runDetails([session]), false, 19_000);

  assert.equal(lines.length, 5);
  assert.equal(lines[1], "    ✓ read file-5.ts · 0s");
  assert.equal(lines[3], "    ✓ read file-3.ts · 0s");
  assert.equal(lines[4], "    +3 additional tool calls");
});

test("collapsed run view collapses a finished subagent's tools while a sibling keeps running", () => {
  const done = fakeAgent({
    id: "d", config: { name: "done" }, createdAt: 1,
    status: { kind: "completed", startedAt: 1_000, completedAt: 2_000, response: "ok" },
    activity: { toolHistory: [{ id: "r", name: "read", inputSummary: "done.ts", startedAt: 1_000, completedAt: 1_500 }] },
  });
  const active = fakeAgent({
    id: "a", config: { name: "active" }, createdAt: 2,
    status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory: [{ id: "b", name: "bash", inputSummary: "npm test", startedAt: 1_000 }] },
  });

  const lines = formatSubagentToolLines(runDetails([done, active]), false, 5_000);

  // The finished subagent shows only its row (its results state); the running sibling keeps its tools.
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^  ✓ done /);
  assert.match(lines[1], / active /);
  assert.match(lines[2], /bash npm test/);
  assert.doesNotMatch(lines.join("\n"), /read done\.ts/);
});

test("tool lines truncate a long input summary to the configured length", () => {
  const longPath = `packages/subagent/src/view/${"a".repeat(120)}.ts`;
  const session = fakeAgent({
    config: { name: "reviewer" }, status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory: [{ id: "r", name: "read", inputSummary: longPath, startedAt: 1_000, completedAt: 1_500 }] },
  });

  const lines = formatSubagentToolLines(runDetails([session]), false, 5_000);

  const summary = lines[1].match(/ read (.+) · \d/)?.[1];
  assert.ok(summary, "expected a tool line with a summary segment");
  assert.equal(summary.length, 80); // 79 chars + the ellipsis
  assert.ok(summary.endsWith("…"));
  assert.doesNotMatch(lines[1], /a{100}/); // the 120-'a' run is cut well short
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

test("expanded subagent run renders a previous run section above the current run for a resumed agent", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    label: "auth review",
    prompt: "Current prompt: finish the review.",
    status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory: [
      { id: "edit", name: "edit", inputSummary: "packages/subagent/src/domain/agent.ts", startedAt: 11_000 },
    ] },
    previousRuns: [
      fakeRunSection({
        prompt: "Previous prompt: start the review.",
        status: { kind: "completed", startedAt: 1_000, completedAt: 43_000, response: "previous output snippet" },
        activity: { toolHistory: [
          { id: "read", name: "read", inputSummary: "packages/subagent/src/domain/agent.ts", startedAt: 2_000, completedAt: 3_000 },
          { id: "bash", name: "bash", inputSummary: "npm test --workspace=@pi9/subagent", startedAt: 4_000, completedAt: 16_000 },
        ] },
      }),
    ],
  });

  const lines = formatSubagentToolLines(runDetails([session]), true, 19_000);
  const joined = lines.join("\n");

  // A clearly-marked previous run section with its status and elapsed time.
  const prevIdx = lines.findIndex(line => /Previous run 1 · completed · 42s/.test(line));
  assert.notEqual(prevIdx, -1);

  // The previous run's own prompt, tool history, and result snippet.
  assert.match(joined, /Previous prompt: start the review\./);
  assert.match(joined, /✓ read packages\/subagent\/src\/domain\/agent\.ts · 1s/);
  assert.match(joined, /✓ bash npm test --workspace=@pi9\/subagent · 12s/);
  assert.match(joined, /Result: previous output snippet/);

  // The current run still renders its own prompt and tool below the previous section.
  const currentPromptIdx = lines.findIndex(line => /Current prompt: finish the review\./.test(line));
  assert.ok(currentPromptIdx > prevIdx, "current run renders below the previous run section");
  assert.match(joined, /edit packages\/subagent\/src\/domain\/agent\.ts/);
});

test("the current run tool history excludes previous run tools for a resumed agent", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    prompt: "Current work.",
    status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory: [
      { id: "edit", name: "edit", inputSummary: "current.ts", startedAt: 11_000 },
    ] },
    previousRuns: [
      fakeRunSection({
        prompt: "Earlier work.",
        status: { kind: "completed", startedAt: 1_000, completedAt: 5_000, response: "ok" },
        activity: { toolHistory: [
          { id: "read", name: "read", inputSummary: "previous.ts", startedAt: 2_000, completedAt: 3_000 },
        ] },
      }),
    ],
  });

  const lines = formatSubagentToolLines(runDetails([session]), true, 12_000);
  const currentPromptIdx = lines.findIndex(line => /Current work\./.test(line));
  const currentRunLines = lines.slice(currentPromptIdx);

  // The current run lists its own tool but never the previous run's tool.
  assert.ok(currentRunLines.some(line => /edit current\.ts/.test(line)));
  assert.ok(!currentRunLines.some(line => /read previous\.ts/.test(line)));
  // The previous tool renders only in the previous section, above the current prompt.
  assert.ok(lines.slice(0, currentPromptIdx).some(line => /read previous\.ts/.test(line)));
});

test("expanded subagent run renders multiple previous run sections in chronological order", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    prompt: "Third prompt.",
    status: { kind: "running", startedAt: 1_000 },
    previousRuns: [
      fakeRunSection({ prompt: "First prompt.", status: { kind: "completed", startedAt: 1_000, completedAt: 2_000, response: "first" } }),
      fakeRunSection({ prompt: "Second prompt.", status: { kind: "error", startedAt: 1_000, completedAt: 3_000, error: "boom" } }),
    ],
  });

  const lines = formatSubagentToolLines(runDetails([session]), true, 4_000);

  const firstIdx = lines.findIndex(line => /Previous run 1 · completed/.test(line));
  const secondIdx = lines.findIndex(line => /Previous run 2 · error/.test(line));
  const currentIdx = lines.findIndex(line => /Third prompt\./.test(line));

  assert.notEqual(firstIdx, -1);
  assert.notEqual(secondIdx, -1);
  assert.ok(firstIdx < secondIdx, "earlier run renders above the later run");
  assert.ok(secondIdx < currentIdx, "all previous runs render above the current run");
});

test("collapsed subagent run does not render previous run sections for a resumed agent", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    prompt: "Current work.",
    status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory: [
      { id: "edit", name: "edit", inputSummary: "current.ts", startedAt: 11_000 },
    ] },
    previousRuns: [
      fakeRunSection({
        prompt: "Earlier work.",
        status: { kind: "completed", startedAt: 1_000, completedAt: 5_000, response: "ok" },
        activity: { toolHistory: [{ id: "read", name: "read", inputSummary: "previous.ts", startedAt: 2_000, completedAt: 3_000 }] },
      }),
    ],
  });

  const joined = formatSubagentToolLines(runDetails([session]), false, 12_000).join("\n");

  assert.doesNotMatch(joined, /Previous run/);
  assert.doesNotMatch(joined, /Earlier work\./);
  assert.doesNotMatch(joined, /read previous\.ts/);
  // The collapsed current row and its recent tool still render.
  assert.match(joined, /edit current\.ts/);
});

test("results expanded mirrors the running view for a resumed snapshot, including its previous-run sections", () => {
  const details = resultsDetails([
    { snapshot: fakeAgent({
      id: "sess-1", label: "phase 2", resumed: true, config: { name: "helper", resumable: true },
      prompt: "Final prompt.",
      status: { kind: "completed", startedAt: 1, completedAt: 2, response: "final output", resumed: true },
      previousRuns: [
        fakeRunSection({ prompt: "First prompt.", status: { kind: "completed", startedAt: 1, completedAt: 2, response: "earlier output" } }),
      ],
    }) },
  ]);
  const expanded = formatSubagentToolLines(details, true, 0).join("\n");

  // The current run renders as a run-style row + prompt + result snippet.
  assert.match(expanded, /✓ helper  phase 2/);
  assert.match(expanded, /resumed/);
  assert.match(expanded, /Final prompt\./);
  assert.match(expanded, /Result: final output/);
  // Completed expanded now matches the running expanded view, so previous-run sections render too.
  assert.match(expanded, /Previous run 1 · completed/);
  assert.match(expanded, /First prompt\./);
  assert.match(expanded, /Result: earlier output/);
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
