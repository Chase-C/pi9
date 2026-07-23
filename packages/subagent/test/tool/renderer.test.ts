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
  assert.equal(renderResult(partial, false, true), [
    "✓ auth map · completed",
    "  Mapped auth.",
    "",
    "● test audit · running",
    "  waiting for result",
  ].join("\n"));
  assert.equal(renderResult(details, true), [
    "✓ auth map · completed",
    "  conversation quiet-otter · run search-boldly",
    "  Mapped auth.",
    "",
    "× test audit · error",
    "  conversation calm-wren · run test-thoroughly",
    "  Child failed.",
  ].join("\n"));
});

test("join renders recent filtered activity, recursive groups, outcomes, and background details", () => {
  const details: SubagentToolDetails = {
    action: "join",
    runs: [{
      conversationId: "root-conversation" as any,
      runId: "root-run" as any,
      agent: "worker",
      label: "root task",
      kind: "spawn",
      prompt: "Investigate the whole system.",
      status: "running",
      joinToolCallIds: ["represented-join"],
      activity: [
        { tool: "old", summary: "too old" },
        { tool: "read", summary: "a" },
        { tool: "subagent", summary: "join", toolCallId: "represented-join" },
        { tool: "grep", summary: "b" },
        { tool: "bash", summary: "c" },
      ],
      joins: [
        { status: "completed", toolCallId: "represented-join", targets: [{ conversationId: "c1" as any, runId: "r1" as any, label: "child", agent: "scout", status: "completed" }] },
        { status: "completed", targets: [{ conversationId: "c1" as any, runId: "r1" as any, label: "child", agent: "scout", status: "error", error: "target failed" }] },
        { status: "running", targets: [{ conversationId: "c2" as any, runId: "r2" as any, label: "branch", status: "running", activity: [{ tool: "read", summary: "nested" }], joins: [{ status: "running", targets: [{ conversationId: "c3" as any, runId: "r3" as any, label: "leaf", agent: "reviewer", status: "running" }] }] }] },
      ],
      background: [{ ownerRunId: "root-run" as any, ownerLabel: "root task", entries: [
        { conversationId: "bg-c1" as any, runId: "bg-r1" as any, label: "watcher", status: "running" },
        { conversationId: "bg-c2" as any, runId: "bg-r2" as any, label: "done bg", status: "completed", detachedAtFinal: true },
      ] }],
    }],
  };
  const collapsed = renderResult(details);
  assert.match(collapsed, /subagent join\(1 run\) · 5 total tool calls/);
  assert.doesNotMatch(collapsed, /too old|read\(a\)|grep\(b\)|bash\(c\)/);
  assert.match(collapsed, /✓ joined 1 · child[\s\S]*✓ joined 1 · child/);
  assert.match(collapsed, /╰─ ● branch · running[\s\S]*subagent join\(1 run\) · 1 total tool call[\s\S]*╰─ ● leaf · reviewer · running/);
  assert.doesNotMatch(collapsed, /read\(nested\)/);
  assert.match(collapsed, /background · 1 active · 1 completed/);
  assert.doesNotMatch(collapsed, /bg-r2|detached at final/);

  const expanded = renderResult(details, true);
  assert.match(expanded, /Investigate the whole system\./);
  assert.match(expanded, /conversation bg-c2 · run bg-r2 · detached at final/);
});

test("join activity is newest-first and reports hidden tool calls", () => {
  const details: SubagentToolDetails = {
    action: "join",
    runs: [{
      conversationId: "root-c" as any,
      runId: "root-r" as any,
      label: "activity",
      status: "running",
      activity: [
        { tool: "first", summary: "1" },
        { tool: "second", summary: "2" },
        { tool: "third", summary: "3" },
        { tool: "fourth", summary: "4" },
        { tool: "fifth", summary: "5" },
      ],
    }],
  };

  assert.equal(renderResult(details), [
    "● activity · running",
    "  fifth(5)",
    "  fourth(4)",
    "  third(3)",
    "  +2 tool calls",
  ].join("\n"));
});

test("terminal join collapse hides history while expansion retains it and never renders nested answers", () => {
  const details = { action: "join", runs: [{
    conversationId: "root-c" as any, runId: "root-r" as any, label: "finished", status: "completed", output: "Root answer.", prompt: "Full prompt.",
    activity: [{ tool: "read", summary: "history" }],
    joins: [{ status: "completed", targets: [{ conversationId: "child-c" as any, runId: "child-r" as any, label: "child", status: "completed", output: "SECRET CHILD ANSWER" }] }],
  }] } as unknown as SubagentToolDetails;
  assert.equal(renderResult(details), "✓ finished · completed\n  Root answer.");
  const expanded = renderResult(details, true);
  assert.match(expanded, /Full prompt\.|read\(history\)|✓ joined 1 · child|child · completed/);
  assert.doesNotMatch(expanded, /SECRET CHILD ANSWER/);
});

test("expanded terminal joins retain recursive history, node-local filtering, and detached backgrounds", () => {
  const details: SubagentToolDetails = {
    action: "join",
    runs: [{
      conversationId: "root-c" as any,
      runId: "root-r" as any,
      label: "root",
      status: "completed",
      output: "root answer",
      activity: [
        { toolCallId: "same-id", tool: "subagent", summary: "root represented join" },
        { toolCallId: "child-only-id", tool: "read", summary: "parent activity survives" },
      ],
      joins: [{
        status: "completed",
        toolCallId: "same-id",
        targets: [{
          conversationId: "child-c" as any,
          runId: "child-r" as any,
          label: "child",
          status: "completed",
          activity: [
            { toolCallId: "same-id", tool: "read", summary: "child activity survives" },
            { toolCallId: "child-only-id", tool: "subagent", summary: "child represented join" },
          ],
          joins: [{
            status: "completed",
            toolCallId: "child-only-id",
            targets: [{ conversationId: "leaf-c" as any, runId: "leaf-r" as any, label: "leaf", status: "completed" }],
          }],
          background: [{ ownerRunId: "child-r" as any, ownerLabel: "child", entries: [{
            conversationId: "background-c" as any,
            runId: "background-r" as any,
            label: "background child",
            status: "running",
            detachedAtFinal: true,
          }] }],
        }],
      }],
    }],
  };

  assert.equal(renderResult(details), "✓ root · completed\n  root answer");
  const expanded = renderResult(details, true);
  assert.match(expanded, /✓ joined 1 · child[\s\S]*child · completed[\s\S]*read\(child activity survives\)/);
  assert.match(expanded, /✓ joined 1 · leaf[\s\S]*leaf · completed/);
  assert.match(expanded, /conversation background-c · run background-r · detached at final/);
  assert.match(expanded, /parent activity survives/);
  assert.doesNotMatch(expanded, /root represented join|child represented join/);
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
