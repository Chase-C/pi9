import { test } from "vitest";
import assert from "node:assert/strict";

import {
  agentsDetails,
  backgroundStartedDetails,
  createSubagentTextComponent,
  formatSubagentToolLines,
  formatWidgetLines,
  inventoryDetails,
  resultsDetails,
  runDetails,
  runSummary,
} from "../../src/view/format.js";
import { fakeAgent, fakeRunSection } from "../helpers/fake-agent.js";

test("expanded agents action nests available details below each name without instructions", () => {
  const agent = {
    name: "helper",
    description: "Reviews implementation changes.",
    source: "project" as const,
    sourcePath: "/project/.pi/agents/helper.md",
    model: "gpt-5.6-sol",
    thinking: "high" as const,
    tools: ["read", "grep"],
    skills: ["review"],
    retainConversation: true,
    systemPrompt: "SECRET AGENT INSTRUCTIONS",
  };
  const lines = formatSubagentToolLines(agentsDetails([agent]), true);
  const rendered = lines.join("\n");

  assert.equal(lines[0], "helper");
  assert.equal(lines.slice(1).every(line => line.startsWith("  ")), true);
  for (const value of [agent.description, agent.source, agent.sourcePath, agent.model, agent.thinking, ...agent.tools, ...agent.skills]) {
    assert.match(rendered, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(rendered, /SECRET AGENT INSTRUCTIONS/);
});

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

test("collapsed inventory renders one results-style identity row per session", () => {
  const sessions = [
    fakeAgent({ id: "s1", config: { name: "done" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } }),
    fakeAgent({ id: "s2", config: { name: "active" }, label: "phase two", status: { kind: "running", startedAt: 1 }, turns: 3, usage: { ...fakeAgent().usage!, totalTokens: 42 } }),
    fakeAgent({ id: "s3", config: { name: "failed" }, messageSnippet: "private", status: { kind: "error", startedAt: 1, completedAt: 2, error: "boom" } }),
  ];

  const lines = formatSubagentToolLines(inventoryDetails(sessions, { status: ["completed", "running", "error"] }), false, 10_000);

  assert.equal(lines.length, 3);
  assert.match(lines[0], /^  ✓ done$/);
  assert.match(lines[1], /^  ● active  phase two$/);
  assert.match(lines[2], /^  ✗ failed$/);
  assert.doesNotMatch(lines.join("\n"), /filter:|tool|token|\d+s|private|boom|outcome:/);
});

test("background dispatch stays out of collapsed inventory and appears in expanded metadata", () => {
  const background = fakeAgent({ id: "s2", dispatch: "background", retention: "persistent", config: { name: "helper", retainConversation: true }, status: { kind: "running", startedAt: 1 } });

  assert.doesNotMatch(formatSubagentToolLines(inventoryDetails([background]), false, 0).join("\n"), /dispatch:/);
  assert.match(formatSubagentToolLines(inventoryDetails([background]), true, 0).join("\n"), /dispatch:background/);
});

test("background-started view collapses to only the started count", () => {
  const sessions = [
    fakeAgent({ id: "s1", dispatch: "background", retention: "persistent", config: { name: "scout" }, status: { kind: "queued" } }),
    fakeAgent({ id: "s2", dispatch: "background", retention: "persistent", config: { name: "reviewer" }, status: { kind: "running", startedAt: 1 } }),
  ];

  assert.deepEqual(formatSubagentToolLines(backgroundStartedDetails(sessions), false, 0), [
    "2 background subagents started",
  ]);
});

test("background-started view expanded shows agent, task label, and session id", () => {
  const sessions = [
    fakeAgent({ id: "scout-1", dispatch: "background", retention: "persistent", config: { name: "scout" }, label: "frontend auth", status: { kind: "queued" } }),
    fakeAgent({ id: "rev-1", dispatch: "background", retention: "persistent", config: { name: "reviewer" }, status: { kind: "running", startedAt: 1 } }),
  ];

  const expanded = formatSubagentToolLines(backgroundStartedDetails(sessions), true, 0).join("\n");
  assert.match(expanded, /scout  frontend auth · scout-1/);
  assert.match(expanded, /reviewer · rev-1/);
  assert.doesNotMatch(expanded, /queued|running/);
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
      id: "sess-1", label: "phase 1", kind: "resume", config: { name: "helper", retainConversation: true },
      status: { kind: "completed", startedAt: 1, completedAt: 2, response: "all done" },
    }) },
    { snapshot: fakeAgent({ id: "flaky-1", config: { name: "flaky" }, status: { kind: "error", startedAt: 1, completedAt: 2, error: "boom" } }) },
  ]);
  const expanded = formatSubagentToolLines(details, true, 0).join("\n");
  assert.match(expanded, /✓ helper  phase 1/);
  assert.match(expanded, /attempt:resume/);
  assert.match(expanded, /all done/);
  assert.match(expanded, /✗ flaky/);
  assert.match(expanded, /boom/);
  // The snippet renders bare in the run/results body — no "Result:"/"Error:" label.
  assert.doesNotMatch(expanded, /Result:|Error:/);
  // Status shows via glyph, not text, and the raw session handle is no longer surfaced in the view.
  assert.doesNotMatch(expanded, /session:/);
});

test("background-started details project collectable handles with sessionId and optional label", () => {
  const sessions = [
    fakeAgent({ id: "a", dispatch: "background", retention: "persistent", config: { name: "scout" }, inputIndex: 0, label: "alpha", status: { kind: "queued" } }),
    fakeAgent({ id: "preflight", dispatch: "background", retention: "transient", config: { name: "missing" }, inputIndex: 1, status: { kind: "error", error: "Unknown agent" } }),
    fakeAgent({ id: "b", dispatch: "background", retention: "persistent", config: { name: "reviewer" }, inputIndex: 2, status: { kind: "queued" } }),
  ];

  const details = backgroundStartedDetails(sessions);
  assert.equal(details.view, "background-started");
  assert.equal(details.count, 2);
  assert.deepEqual(details.handles, [
    { sessionId: "a", agent: "scout", label: "alpha" },
    { sessionId: "b", agent: "reviewer" },
  ]);
});

test("flat inventory sessions render in caller order with results-style row indentation", () => {
  const a = fakeAgent({ id: "a", config: { name: "alpha" }, createdAt: 30, status: { kind: "running", startedAt: 1 } });
  const b = fakeAgent({ id: "b", config: { name: "beta" }, createdAt: 10, status: { kind: "running", startedAt: 1 } });
  const orphan = fakeAgent({ id: "c", parentSessionId: "missing-parent", config: { name: "orphan" }, createdAt: 20, status: { kind: "running", startedAt: 1 } });

  const headLines = formatSubagentToolLines(inventoryDetails([a, b, orphan]), false, 1_000);
  assert.deepEqual(headLines, ["  ● alpha", "  ● beta", "  ● orphan"]);
});

test("inventory expanded output orders descendants DFS under their parents with depth indent", () => {
  const root = fakeAgent({ id: "r1", config: { name: "alpha" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const root2 = fakeAgent({ id: "r2", config: { name: "delta" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });
  const child = fakeAgent({ id: "c1", parentSessionId: "r1", config: { name: "beta" }, createdAt: 3, status: { kind: "running", startedAt: 1 } });
  const grandchild = fakeAgent({ id: "g1", parentSessionId: "c1", config: { name: "gamma" }, createdAt: 4, status: { kind: "running", startedAt: 1 } });

  const lines = formatSubagentToolLines(inventoryDetails([child, root, grandchild, root2]), true, 1_000);
  const headLines = lines.filter(line => line.includes("●"));

  assert.deepEqual(headLines, [
    "  ● alpha",
    "    ● beta",
    "      ● gamma",
    "  ● delta",
  ]);
});

test("expanded inventory renders lifecycle metadata without run or result narrative", () => {
  const root = fakeAgent({
    id: "root-session",
    config: { name: "planner", retainConversation: true },
    prompt: "PROMPT_MUST_NOT_RENDER",
    messageSnippet: "MESSAGE_MUST_NOT_RENDER",
    activity: { toolHistory: [{ id: "tool-1", name: "read", inputSummary: "TOOL_MUST_NOT_RENDER", startedAt: 2, completedAt: 3 }] },
    status: { kind: "completed", startedAt: 1, completedAt: 4, response: "OUTPUT_MUST_NOT_RENDER" },
  });
  const child = fakeAgent({
    id: "child-session",
    parentSessionId: "root-session",
    config: { name: "reviewer", retainConversation: false },
    prompt: "CHILD_PROMPT_MUST_NOT_RENDER",
    messageSnippet: "CHILD_MESSAGE_MUST_NOT_RENDER",
    activity: { toolHistory: [{ id: "tool-2", name: "bash", inputSummary: "CHILD_TOOL_MUST_NOT_RENDER", startedAt: 2 }] },
    status: { kind: "error", startedAt: 1, completedAt: 4, error: "ERROR_MUST_NOT_RENDER" },
  });

  const lines = formatSubagentToolLines(inventoryDetails([child, root]), true, 5);
  const rendered = lines.join("\n");

  assert.match(rendered, /^  ✓ planner$/m);
  assert.match(rendered, /^    ✗ reviewer$/m);
  assert.match(rendered, /session:root-session/);
  assert.match(rendered, /dispatch:foreground/);
  assert.match(rendered, /retained:true/);
  assert.match(rendered, /parent:root-session/);
  assert.match(rendered, /retained:false/);
  assert.doesNotMatch(rendered, /PROMPT_MUST_NOT_RENDER|MESSAGE_MUST_NOT_RENDER|TOOL_MUST_NOT_RENDER|OUTPUT_MUST_NOT_RENDER|ERROR_MUST_NOT_RENDER|tool call|token|\d+s/);

  const rootRow = lines.findIndex(line => line === "  ✓ planner");
  const rootMetadata = lines.findIndex(line => line === "    session:root-session");
  const childRow = lines.findIndex(line => line === "    ✗ reviewer");
  const childMetadata = lines.findIndex(line => line === "      session:child-session");
  assert.ok(rootRow >= 0 && rootMetadata > rootRow && childRow > rootMetadata && childMetadata > childRow);
});

test("formatWidgetLines flattens nested background agents into the Background section without tree indentation", () => {
  const root = fakeAgent({ id: "root", dispatch: "background", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const childA = fakeAgent({ id: "child-a", parentSessionId: "root", dispatch: "background", config: { name: "child-a" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });
  const childB = fakeAgent({ id: "child-b", parentSessionId: "root", dispatch: "background", config: { name: "child-b" }, createdAt: 3, status: { kind: "running", startedAt: 1 } });
  const grandchild = fakeAgent({ id: "grand", parentSessionId: "child-a", dispatch: "background", config: { name: "grand" }, createdAt: 4, status: { kind: "running", startedAt: 1 } });

  const lines = formatWidgetLines([root, childA, childB, grandchild], 1_000);

  assert.equal(lines[0], "Background · 4 running");
  assert.equal(lines.length, 5);
  for (const line of lines.slice(1)) assert.match(line, /^  /);
  assert.match(lines.join("\n"), /root/);
  assert.match(lines.join("\n"), /child-a/);
  assert.match(lines.join("\n"), /child-b/);
  assert.match(lines.join("\n"), /grand/);
  assert.doesNotMatch(lines.join("\n"), /^    /m);
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
  assert.match(lines[1], /^  ╰─ ⠋ beta/);
  assert.match(lines[2], /^    ╰─ ⠋ gamma/);
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
  assert.equal(lines[0], "  ⠇ reviewer  4 tool calls · 0 tokens · 18s");
  assert.equal(lines[1], "    ╰ bash(npm test --workspace=@pi9/subagent) · 12s");
  assert.equal(lines[2], '    ╰ grep("formatRunSessionLine" in packages/subagent/src) · 1s');
  assert.equal(lines[3], "    ╰ read(packages/subagent/src/view/tool-result-lines.ts) · 0s");
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
  assert.equal(lines[1], "    ╰ read(file-5.ts) · 0s");
  assert.equal(lines[3], "    ╰ read(file-3.ts) · 0s");
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
  assert.match(lines[2], /bash\(npm test\)/);
  assert.doesNotMatch(lines.join("\n"), /read done\.ts/);
});

test("tool lines truncate a long input summary to the configured length", () => {
  const longPath = `packages/subagent/src/view/${"a".repeat(120)}.ts`;
  const session = fakeAgent({
    config: { name: "reviewer" }, status: { kind: "running", startedAt: 1_000 },
    activity: { toolHistory: [{ id: "r", name: "read", inputSummary: longPath, startedAt: 1_000, completedAt: 1_500 }] },
  });

  const lines = formatSubagentToolLines(runDetails([session]), false, 5_000);

  const summary = lines[1].match(/ read\((.+)\) · \d/)?.[1];
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
    "  ⠸ parent  2 tool calls · 0 tokens · 9s",
    "  │ ╰ subagent(run 2 tasks) · 6s",
    "  ╰─ ⠸ child  0 tool calls · 0 tokens · 5s",
  ]);
});

test("expanded subagent run renders labeled prompt and recent-tool sections", () => {
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

  assert.match(lines.join("\n"), /┌ Task\n    │ Review the auth changes and summarize risks\./);
  assert.match(lines.join("\n"), /┌ Tools · 3 calls/);

  // Expanded activity now matches collapsed ordering: newest first, capped at three.
  const editIdx = lines.indexOf("    │ edit(packages/subagent/src/view/session-lines.ts) · 4s");
  assert.notEqual(editIdx, -1);
  assert.equal(lines[editIdx + 1], "    │ bash(npm test --workspace=@pi9/subagent) · 3s");
  assert.equal(lines[editIdx + 2], "    │ read(packages/subagent/src/view/tool-result-lines.ts) · 0s");
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

test("expanded subagent run caps tools at the newest three and counts additional calls", () => {
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
  const toolLines = lines.filter(line => /^    │ read\(file-\d\.ts\) · \d+s$/.test(line));

  assert.equal(toolLines.length, 3);
  assert.match(toolLines[0], /file-4\.ts/);
  assert.match(toolLines[2], /file-2\.ts/);
  assert.match(lines.join("\n"), /\+2 additional tool calls/);
  assert.doesNotMatch(lines.join("\n"), /file-[01]\.ts/);
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

  assert.match(joined, /┌ Task\n    │ Summarize the risks\./);
  const bashIdx = lines.indexOf("    │ bash(npm test) · 2s");
  assert.notEqual(bashIdx, -1);
  const readIdx = lines.indexOf("    │ read(auth.ts) · 0s");
  assert.equal(readIdx, bashIdx + 1);

  const resultIdx = lines.findIndex(line => /Found two issues\./.test(line));
  assert.ok(resultIdx > readIdx, "answer should follow the tools");
  assert.match(joined, /┌ Answer/);
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

  const currentPromptIdx = lines.findIndex(line => /Current prompt: finish the review\./.test(line));
  const prevIdx = lines.findIndex(line => /Previous Run 1 · completed · 42s/.test(line));
  assert.notEqual(prevIdx, -1);
  assert.ok(currentPromptIdx < prevIdx, "the current Task section renders first");

  // A previous run is exactly its compact prompt and response; its tools are omitted.
  assert.match(joined, /Previous prompt: start the review\./);
  assert.match(joined, /previous output snippet/);
  assert.doesNotMatch(joined, /read\(packages\/subagent\/src\/domain\/agent\.ts\) · 1s/);
  assert.doesNotMatch(joined, /bash\(npm test --workspace=@pi9\/subagent\) · 12s/);
  assert.match(joined, /edit\(packages\/subagent\/src\/domain\/agent\.ts\)/);
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

  // The current run lists its own tool; previous-run tool history is omitted entirely.
  assert.ok(currentRunLines.some(line => /edit\(current\.ts\)/.test(line)));
  assert.ok(!lines.some(line => /read\(previous\.ts\)/.test(line)));
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

  const firstIdx = lines.findIndex(line => /Previous Run 1 · completed/.test(line));
  const secondIdx = lines.findIndex(line => /Previous Run 2 · error/.test(line));
  const currentIdx = lines.findIndex(line => /Third prompt\./.test(line));

  assert.notEqual(firstIdx, -1);
  assert.notEqual(secondIdx, -1);
  assert.ok(firstIdx < secondIdx, "earlier run renders above the later run");
  assert.ok(currentIdx < firstIdx, "the current Task section renders before previous runs");
});

test("previous run sections render at most one truncated prompt line and one response line", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    prompt: "Current task.",
    status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" },
    previousRuns: [fakeRunSection({
      prompt: `A long previous prompt ${"p".repeat(180)}\nsecond prompt line`,
      status: { kind: "completed", startedAt: 1, completedAt: 2, response: `A long previous response ${"r".repeat(180)}\nsecond response line` },
    })],
  });

  const rendered = createSubagentTextComponent(runDetails([session]), true, undefined, 2)!.render(52);
  const header = rendered.findIndex(line => line.includes("Previous Run 1"));
  const close = rendered.indexOf("    └", header);
  const section = rendered.slice(header, close + 1);

  assert.equal(section.length, 4);
  assert.match(section[1], /…/);
  assert.match(section[2], /…/);
});

test("wrapped bracket content repeats a muted bar independently of content color", () => {
  const session = fakeAgent({
    config: { name: "reviewer" },
    prompt: `Long task ${"prompt ".repeat(18)}`,
    status: { kind: "completed", startedAt: 1, completedAt: 2, response: `Long answer ${"response ".repeat(18)}` },
  });
  const theme = {
    fg(color: string, text: string) {
      const code = color === "muted" ? 90 : color === "success" ? 32 : 37;
      return `\x1b[${code}m${text}\x1b[0m`;
    },
  };

  const rendered = createSubagentTextComponent(runDetails([session]), true, theme as any, 2)!.render(38);
  const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
  const sectionContent = (label: string) => {
    const header = rendered.findIndex(line => plain(line).includes(`┌ ${label}`));
    const close = rendered.findIndex((line, index) => index > header && plain(line) === "    └");
    return rendered.slice(header + 1, close);
  };
  const task = sectionContent("Task");
  const answer = sectionContent("Answer");

  assert.ok(task.length > 1);
  assert.ok(answer.length > 1);
  for (const line of [...task, ...answer]) {
    assert.match(line, /^    \x1b\[90m│\x1b\[0m /);
  }
  assert.ok(answer.every(line => line.includes("\x1b[32m")), "answer text remains success-colored");
});

test("expanded recursive runs summarize descendants in a Subagents section", () => {
  const root = fakeAgent({ id: "root", config: { name: "root" }, status: { kind: "running", startedAt: 1 } });
  const child = fakeAgent({ id: "child", parentSessionId: "root", config: { name: "child" }, label: "delegated check", prompt: "CHILD PROMPT", status: { kind: "running", startedAt: 2 } });
  const grandchild = fakeAgent({ id: "grand", parentSessionId: "child", config: { name: "grand" }, prompt: "GRANDCHILD PROMPT", status: { kind: "completed", startedAt: 3, completedAt: 4, response: "child output" } });

  const rendered = formatSubagentToolLines(runDetails([root], { subtree: [root, child, grandchild] }), true, 5).join("\n");

  assert.match(rendered, /┌ Subagents · 2/);
  assert.match(rendered, /⠋ child  delegated check  0 tool calls · 0 tokens · 0s/);
  assert.match(rendered, /  ✓ grand  0 tool calls · 0 tokens · 0s/);
  assert.doesNotMatch(rendered, /CHILD PROMPT|GRANDCHILD PROMPT|child output/);
});

test("expanded results render retained recursive subagent summaries", () => {
  const child = fakeAgent({ id: "child", parentSessionId: "root", config: { name: "child" }, status: { kind: "completed", startedAt: 1, completedAt: 2 } });
  const root = fakeAgent({ id: "root", config: { name: "root" }, status: { kind: "completed", startedAt: 1, completedAt: 3, response: "done" }, subagents: [child] });

  const rendered = formatSubagentToolLines(resultsDetails([{ snapshot: root }]), true, 3).join("\n");

  assert.match(rendered, /┌ Subagents · 1/);
  assert.match(rendered, /✓ child/);
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
  assert.doesNotMatch(joined, /read\(previous\.ts\)/);
  // The collapsed current row and its recent tool still render.
  assert.match(joined, /edit\(current\.ts\)/);
});

test("results expanded mirrors the running view for a resumed snapshot, including its previous-run sections", () => {
  const details = resultsDetails([
    { snapshot: fakeAgent({
      id: "sess-1", label: "phase 2", kind: "resume", config: { name: "helper", retainConversation: true },
      prompt: "Final prompt.",
      status: { kind: "completed", startedAt: 1, completedAt: 2, response: "final output" },
      previousRuns: [
        fakeRunSection({ prompt: "First prompt.", status: { kind: "completed", startedAt: 1, completedAt: 2, response: "earlier output" } }),
      ],
    }) },
  ]);
  const expanded = formatSubagentToolLines(details, true, 0).join("\n");

  // The current run renders as a run-style row + prompt + result snippet.
  assert.match(expanded, /✓ helper  phase 2/);
  assert.match(expanded, /attempt:resume/);
  assert.match(expanded, /Final prompt\./);
  assert.match(expanded, /final output/);
  // Completed expanded now matches the running expanded view, so previous-run sections render too.
  assert.match(expanded, /Previous Run 1 · completed/);
  assert.match(expanded, /First prompt\./);
  assert.match(expanded, /earlier output/);
});

test("runSummary counts retained result subagents without double-counting ids", () => {
  const child = fakeAgent({ id: "child", parentSessionId: "root", status: { kind: "completed", startedAt: 2, completedAt: 3 } });
  const root = fakeAgent({ id: "root", subagents: [child], status: { kind: "completed", startedAt: 1, completedAt: 4 } });

  const summary = runSummary(resultsDetails([{ snapshot: root }, { snapshot: child }]), 4);

  assert.deepEqual(
    { running: summary?.running, queued: summary?.queued, finished: summary?.finished },
    { running: 0, queued: 0, finished: 2 },
  );
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
