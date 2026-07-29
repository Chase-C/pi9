import assert from "node:assert/strict";
import { test } from "vitest";
import { renderSubagentCall, renderSubagentResult, type SubagentToolDetails } from "../../src/tool-renderer.js";

const lines = (component: { render(width: number): string[] }) => component.render(200).map(line => line.trimEnd()).join("\n");
const renderCall = (args: unknown) => lines(renderSubagentCall(args));
const renderResult = (details: SubagentToolDetails, expanded = false, isPartial = false, width = 200) =>
  renderSubagentResult({ details }, { expanded, isPartial }).render(width).map(line => line.trimEnd()).join("\n");

test("call titles summarize action-specific input counts", () => {
  assert.equal(renderCall({ action: "spawn", spawns: [{}, {}] }), "subagent spawn  2 tasks");
  assert.equal(renderCall({ action: "resume", resumes: [{}] }), "subagent resume  1 task");
  assert.equal(renderCall({ action: "steer", messages: [{}, {}] }), "subagent steer  2 messages");
  assert.equal(renderCall({ action: "cancel", runIds: ["one", "two"] }), "subagent cancel  2 runs");
  assert.equal(renderCall({ action: "inspect", runIds: ["one"] }), "subagent inspect  1 run");
  assert.equal(renderCall({ action: "join", runIds: ["one", "two"] }), "subagent join  2 runs");
  assert.equal(renderCall({ action: "remove", conversationIds: ["one"] }), "subagent remove  1 conversation");
  assert.equal(renderCall({ action: "agents" }), "subagent agents");
  assert.equal(
    lines(renderSubagentCall({ action: "spawn" }, { bold: text => `<b>${text}</b>` })),
    "<b>subagent</b> spawn",
  );
});

test("spawn uses outcome-first collapsed output and tagged delegation blocks when expanded", () => {
  const details: SubagentToolDetails = {
    action: "spawn",
    tasks: [
      { inputIndex: 0, kind: "spawn", agent: "scout", label: "auth map", prompt: "Map auth.", conversationId: "quiet-otter" as any, runId: "search-boldly" as any },
      { inputIndex: 1, kind: "spawn", agent: "reviewer", label: "risk review", prompt: "Review risks.", conversationId: "amber-fox" as any, runId: "inspect-carefully" as any },
    ],
  };

  assert.equal(renderResult(details), [
    "✓ Started 2 new conversations",
    "  auth map · risk review",
  ].join("\n"));
  assert.equal(renderResult(details, true), [
    "→ auth map · scout · spawn",
    "  Map auth.",
    "  started · conversation quiet-otter · run search-boldly",
    "",
    "→ risk review · reviewer · spawn",
    "  Review risks.",
    "  started · conversation amber-fox · run inspect-carefully",
  ].join("\n"));
});

test("steer renders receipts and inspect renders bounded activity", () => {
  const steer: SubagentToolDetails = {
    action: "steer",
    tasks: [{ inputIndex: 0, kind: "steer", agent: "scout", prompt: "Focus tests.", conversationId: "quiet-otter" as any, runId: "search-boldly" as any, steer: { id: 1, state: "queued", acceptedAt: 1 } }],
  };
  assert.equal(renderResult(steer), "✓ Steered 1 run\n  scout");
  assert.match(renderResult(steer, true), /scout · steer[\s\S]*Focus tests\.[\s\S]*steered[\s\S]*steer #1 queued/);

  const inspect: SubagentToolDetails = {
    action: "inspect",
    runs: [{
      conversationId: "quiet-otter" as any,
      runId: "search-boldly" as any,
      rootRunId: "search-boldly" as any,
      depth: 0,
      agent: "scout",
      status: "running",
      phase: "thinking",
      elapsedMs: 25,
      turns: 2,
      compactions: 1,
      messageSnippet: "Checking tests.",
      recentTools: [{ toolCallId: "t1", tool: "read", summary: "test.ts", status: "completed" }],
      steers: [{ id: 1, state: "processed", acceptedAt: 1, deliveredAt: 2, processedAt: 3 }],
    }],
  };
  assert.equal(renderResult(inspect), "✓ Inspected 1 run · 1 running\n  scout");
  assert.match(renderResult(inspect, true), /running · thinking[\s\S]*\[partial\] Checking tests\.[\s\S]*read\(test.ts\) · completed[\s\S]*steer #1 · processed/);
});

test("inspect renders terminal error diagnostics in expanded mode", () => {
  const inspect: SubagentToolDetails = {
    action: "inspect",
    runs: [{
      conversationId: "quiet-otter" as any,
      runId: "search-boldly" as any,
      rootRunId: "search-boldly" as any,
      depth: 0,
      agent: "scout",
      status: "error",
      elapsedMs: 25,
      turns: 2,
      compactions: 1,
      errorSnippet: "Model request failed.",
      recentTools: [],
      steers: [],
    }],
  };

  assert.doesNotMatch(renderResult(inspect), /Model request failed/);
  assert.match(renderResult(inspect, true), /Model request failed\./);
});

test("cancel renders successful and failed targets", () => {
  const cancel: SubagentToolDetails = {
    action: "cancel",
    runs: [
      { conversationId: "quiet-otter" as any, runId: "search-boldly", status: "aborted" },
      { runId: "not-an-id", error: "invalid runId format" },
    ],
  };

  assert.equal(renderResult(cancel), "✓ Cancelled 1 run · 1 error\n  search-boldly · not-an-id");
  assert.match(renderResult(cancel, true), /search-boldly · cancelled[\s\S]*not-an-id · not cancelled[\s\S]*invalid runId format/);
});

test("inspect renders per-target errors without hiding the result", () => {
  const inspect: SubagentToolDetails = {
    action: "inspect",
    runs: [{ inputIndex: 0, runId: "not-an-id", error: "invalid runId format" }],
  };

  assert.equal(renderResult(inspect), "✓ Inspected 1 target · 1 error\n  not-an-id");
  assert.match(renderResult(inspect, true), /not-an-id · not inspected[\s\S]*invalid runId format/);
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

test("list renders grouped conversations and nested run status", () => {
  const details: SubagentToolDetails = {
    action: "list",
    conversations: [
      {
        conversationId: "quiet-otter" as any, agent: "scout", label: "auth map", createdAt: 1, canResume: false,
        runs: [{ runId: "search-boldly" as any, rootRunId: "search-boldly" as any, depth: 0, kind: "spawn", status: "running", createdAt: 1 }],
      },
      {
        conversationId: "amber-fox" as any, agent: "reviewer", label: "risk review", createdAt: 2, canResume: true,
        runs: [{ runId: "inspect-carefully" as any, rootRunId: "inspect-carefully" as any, depth: 0, kind: "spawn", status: "completed", createdAt: 2 }],
      },
    ],
  };
  assert.equal(renderResult(details), "✓ Found 2 conversations · 2 runs · 1 running · 1 completed\n  auth map · risk review");
  assert.equal(renderResult(details, true), [
    "→ auth map · scout · 1 run",
    "  conversation quiet-otter",
    "  ● search-boldly · spawn · depth 0 · running",
    "",
    "→ risk review · reviewer · 1 run · resumable",
    "  conversation amber-fox",
    "  ✓ inspect-carefully · spawn · depth 0 · completed",
  ].join("\n"));
});

test("list renders an empty grouped result", () => {
  assert.equal(renderResult({ action: "list", conversations: [] }), "✓ No conversations found");
});

test("join renders target errors without conversation identities", () => {
  const details: SubagentToolDetails = {
    action: "join",
    runs: [{ runId: "not-an-id", status: "error", error: "invalid runId format" }],
  };
  assert.equal(renderResult(details, true), [
    "× not-an-id · error",
    "  not-an-id",
    "",
    "  invalid runId format",
  ].join("\n"));
});

test("join distinguishes partial waits and terminal child errors", () => {
  const details: SubagentToolDetails = {
    action: "join",
    runs: [
      { conversationId: "quiet-otter" as any, runId: "search-boldly" as any, label: "auth map", status: "completed", output: "Mapped auth.", elapsedMs: 12_400, turns: 3, tokens: 24_000 },
      { conversationId: "calm-wren" as any, runId: "test-thoroughly" as any, label: "test audit", status: "error", error: "Child failed.", elapsedMs: 950, turns: 1, tokens: 800 },
    ],
  };
  const partial: SubagentToolDetails = {
    action: "join",
    runs: [
      details.runs[0],
      { conversationId: "calm-wren" as any, runId: "test-thoroughly" as any, label: "test audit", status: "running", elapsedMs: 950, turns: 1, tokens: 800 },
    ],
  };
  assert.equal(renderResult(partial, false, true), [
    "✓ auth map · completed · 12s · 3 turns · 24k tokens",
    "● test audit · running · 950ms · 1 turn · 800 tokens",
    "  waiting for result",
  ].join("\n"));
  assert.equal(renderResult(details, true), [
    "✓ auth map · completed · 12s · 3 turns · 24k tokens",
    "  conversation quiet-otter · run search-boldly",
    "",
    "  Mapped auth.",
    "",
    "× test audit · error · 950ms · 1 turn · 800 tokens",
    "  conversation calm-wren · run test-thoroughly",
    "",
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

test("join trees color status markers and target statuses semantically", () => {
  const details: SubagentToolDetails = {
    action: "join",
    runs: [{
      conversationId: "root-c" as any,
      runId: "root-r" as any,
      label: "root",
      status: "running",
      joins: [{
        status: "completed",
        targets: [{
          conversationId: "child-c" as any,
          runId: "child-r" as any,
          label: "child",
          agent: "scout",
          status: "completed",
          activity: [{ tool: "read" }],
        }, {
          conversationId: "sibling-c" as any,
          runId: "sibling-r" as any,
          label: "sibling",
          status: "completed",
        }],
      }],
    }],
  };
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as any;
  const rendered = lines(renderSubagentResult({ details }, { expanded: true }, theme));

  assert.match(rendered, /<success>✓<\/success> <muted>joined 2 · child, sibling<\/muted>/);
  assert.match(rendered, /<muted>├─<\/muted> <success>✓<\/success> <text>child<\/text><muted> · scout<\/muted> <muted>·<\/muted> <success>completed<\/success>/);
  assert.match(rendered, /<muted>│<\/muted>\s+<muted>read<\/muted>/);
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

test("terminal join collapse hides output and history while expansion retains them without nested answers", () => {
  const details = { action: "join", runs: [{
    conversationId: "root-c" as any, runId: "root-r" as any, label: "finished", status: "completed", output: "Root answer.", prompt: "Full prompt.",
    activity: [{ tool: "read", summary: "history" }],
    joins: [{ status: "completed", targets: [{ conversationId: "child-c" as any, runId: "child-r" as any, label: "child", status: "completed", output: "SECRET CHILD ANSWER" }] }],
  }] } as unknown as SubagentToolDetails;
  assert.equal(renderResult(details), "✓ finished · completed");
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
          elapsedMs: 2_500,
          turns: 2,
          tokens: 1_250,
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

  assert.equal(renderResult(details), "✓ root · completed");
  const expanded = renderResult(details, true);
  assert.match(expanded, /✓ joined 1 · child[\s\S]*child · completed · 2\.5s · 2 turns · 1\.3k tokens[\s\S]*read\(child activity survives\)/);
  assert.match(expanded, /✓ joined 1 · leaf[\s\S]*leaf · completed/);
  assert.match(expanded, /conversation background-c · run background-r · detached at final/);
  assert.match(expanded, /parent activity survives/);
  assert.doesNotMatch(expanded, /root represented join|child represented join/);
});

test("expanded joins order and separate sections while preserving indentation across wraps", () => {
  const details: SubagentToolDetails = {
    action: "join",
    runs: [{
      conversationId: "root-c" as any,
      runId: "root-r" as any,
      label: "wrapped",
      status: "completed",
      prompt: "Prompt words that wrap onto another line.",
      activity: [{ tool: "read", summary: "Tool summary words that also wrap." }],
      output: "Result words that wrap onto another line.",
    }],
  };

  assert.equal(renderResult(details, true, false, 24), [
    "✓ wrapped · completed",
    "  conversation root-c ·",
    "  run root-r",
    "",
    "  Prompt words that wrap",
    "  onto another line.",
    "",
    "  read(Tool summary",
    "  words that also wrap.)",
    "",
    "  Result words that wrap",
    "  onto another line.",
  ].join("\n"));
});

test("remove renders deleted conversations and item-local errors", () => {
  const details: SubagentToolDetails = {
    action: "remove",
    removed: 2,
    conversationIds: ["quiet-otter", "amber-fox"] as any,
    errors: [{ conversationId: "busy-newt", error: "Conversation busy-newt has active run work-slowly. Cancel and join it before removal." }],
  };
  assert.equal(renderResult(details), "✓ Removed 2 conversations · 1 error\n  quiet-otter · amber-fox");
  assert.match(renderResult(details, true), /quiet-otter · removed[\s\S]*amber-fox · removed[\s\S]*busy-newt · not removed[\s\S]*Cancel and join/);
});

test("errors render their message instead of structured output", () => {
  const details: SubagentToolDetails = { action: "error", requestedAction: "join", message: "Unknown run." };
  assert.equal(renderResult(details), "Unknown run.");
});
