import assert from "node:assert/strict";
import { test } from "vitest";
import { renderSubagentCall, renderSubagentResult, type SubagentToolDetails } from "../../src/tool-renderer.js";

const lines = (component: { render(width: number): string[] }) => component.render(200).map(line => line.trimEnd()).join("\n");
const renderCall = (args: unknown) => lines(renderSubagentCall(args));
const renderResult = (details: SubagentToolDetails, expanded = false, isPartial = false) =>
  lines(renderSubagentResult({ details }, { expanded, isPartial }));

test("call titles summarize action-specific input counts", () => {
  assert.equal(renderCall({ action: "run", tasks: [{}, {}, {}] }), "subagent run  3 tasks");
  assert.equal(renderCall({ action: "join", runIds: ["one", "two"] }), "subagent join  2 runs");
  assert.equal(renderCall({ action: "remove", conversationIds: ["one"] }), "subagent remove  1 conversation");
  assert.equal(renderCall({ action: "agents" }), "subagent agents");
  assert.equal(
    lines(renderSubagentCall({ action: "run" }, { bold: text => `<b>${text}</b>` })),
    "<b>subagent</b> run",
  );
});

test("run uses outcome-first collapsed output and tagged delegation blocks when expanded", () => {
  const details: SubagentToolDetails = {
    action: "run",
    tasks: [
      { inputIndex: 0, kind: "spawn", agent: "scout", label: "auth map", prompt: "Map auth.", conversationId: "quiet-otter" as any, runId: "search-boldly" as any },
      { inputIndex: 1, kind: "spawn", agent: "reviewer", label: "risk review", prompt: "Review risks.", conversationId: "amber-fox" as any, runId: "inspect-carefully" as any },
      { inputIndex: 2, kind: "resume", agent: "scout", label: "follow-up", prompt: "Check tests.", conversationId: "bright-heron" as any, runId: "verify-quietly" as any },
    ],
  };

  assert.equal(renderResult(details), [
    "✓ Started 2 new conversations and resumed 1",
    "  auth map · risk review · follow-up",
  ].join("\n"));
  assert.equal(renderResult(details, true), [
    "→ auth map · scout · spawn",
    "  Map auth.",
    "  started · conversation quiet-otter · run search-boldly",
    "",
    "→ risk review · reviewer · spawn",
    "  Review risks.",
    "  started · conversation amber-fox · run inspect-carefully",
    "",
    "→ follow-up · scout · resume",
    "  Check tests.",
    "  started · conversation bright-heron · run verify-quietly",
  ].join("\n"));
});

test("agents render configuration tags in expanded mode", () => {
  const details: SubagentToolDetails = {
    action: "agents",
    agents: [{ name: "scout", description: "Read-only reconnaissance.", source: "project", model: "anthropic/sonnet", thinking: "medium", tools: ["read", "grep"] }],
  };
  assert.equal(renderResult(details), "✓ Found 1 available agent\n  scout");
  assert.equal(renderResult(details, true), [
    "→ scout · project",
    "  Read-only reconnaissance.",
    "  model anthropic/sonnet · thinking medium",
    "  tools read, grep",
  ].join("\n"));
});

test("list renders status summary and tagged run inventory", () => {
  const details: SubagentToolDetails = {
    action: "list",
    runs: [
      { conversationId: "quiet-otter" as any, runId: "search-boldly" as any, agent: "scout", label: "auth map", kind: "spawn", status: "running" },
      { conversationId: "amber-fox" as any, runId: "inspect-carefully" as any, agent: "reviewer", label: "risk review", kind: "spawn", status: "completed" },
    ],
  };
  assert.equal(renderResult(details), "✓ Found 2 runs · 1 running · 1 completed\n  auth map · risk review");
  assert.equal(renderResult(details, true), [
    "→ auth map · scout · spawn",
    "  running · conversation quiet-otter · run search-boldly",
    "",
    "→ risk review · reviewer · spawn",
    "  completed · conversation amber-fox · run inspect-carefully",
  ].join("\n"));
});

test("join distinguishes partial waits and terminal child errors", () => {
  const details: SubagentToolDetails = {
    action: "join",
    runs: [
      { conversationId: "quiet-otter" as any, runId: "search-boldly" as any, label: "auth map", status: "completed", output: "Mapped auth." },
      { conversationId: "calm-wren" as any, runId: "test-thoroughly" as any, label: "test audit", status: "error", error: "Child failed." },
    ],
  };
  const partial: SubagentToolDetails = {
    action: "join",
    runs: [
      details.runs[0],
      { conversationId: "calm-wren" as any, runId: "test-thoroughly" as any, label: "test audit", status: "running" },
    ],
  };
  assert.equal(renderResult(partial, false, true), "✓ Waiting for 2 runs · 1 running · 1 completed\n  auth map · test audit");
  assert.equal(renderResult(details, true), [
    "→ auth map · completed",
    "  Mapped auth.",
    "  conversation quiet-otter · run search-boldly",
    "",
    "× test audit · error",
    "  Child failed.",
    "  conversation calm-wren · run test-thoroughly",
  ].join("\n"));
});

test("remove renders aggregate aborts without assigning them to a conversation", () => {
  const details: SubagentToolDetails = {
    action: "remove",
    removed: 2,
    aborted: 1,
    conversationIds: ["quiet-otter", "amber-fox"] as any,
    errors: [],
  };
  assert.equal(renderResult(details), "✓ Removed 2 conversations · 1 active run aborted\n  quiet-otter · amber-fox");
  assert.equal(renderResult(details, true), [
    "→ quiet-otter · removed",
    "  conversation quiet-otter",
    "",
    "→ amber-fox · removed",
    "  conversation amber-fox",
    "",
    "  1 active run aborted",
  ].join("\n"));
});

test("errors render their message instead of structured output", () => {
  const details: SubagentToolDetails = { action: "error", requestedAction: "join", message: "Unknown run." };
  assert.equal(renderResult(details), "Unknown run.");
});
