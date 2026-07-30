import assert from "node:assert/strict";
import { test } from "vitest";
import { renderSubagentCall, renderSubagentResult, type SubagentToolDetails } from "../../src/tool-renderer.js";

type LegacyRenderFixture = Record<string, any>;

function normalizeDetails(fixture: LegacyRenderFixture): SubagentToolDetails {
  if (fixture.response) return fixture as SubagentToolDetails;
  const action = fixture.action;
  if (action === "error") return { response: { action: fixture.requestedAction ?? "unknown", error: fixture.message } };
  if (action === "spawn" || action === "resume" || action === "steer") {
    return { response: { action, results: [] }, view: { tasks: fixture.tasks } } as SubagentToolDetails;
  }
  if (action === "join") return { response: { action, results: [] }, view: { runs: fixture.runs } };
  if (action === "remove") {
    return {
      response: {
        action,
        results: [
          ...fixture.subagentIds.map((subagentId: any) => ({ ok: true as const, removedIds: [subagentId] })),
          ...fixture.errors.map((error: any) => ({ ok: false as const, ...error })),
        ],
      },
    };
  }
  const results = action === "agents" ? fixture.agents
    : action === "list" ? fixture.conversations
    : fixture.runs;
  return { response: { action, results } } as SubagentToolDetails;
}

const lines = (component: { render(width: number): string[] }) => component.render(200).map(line => line.trimEnd()).join("\n");
const renderCall = (args: unknown) => lines(renderSubagentCall(args));
const renderResult = (details: LegacyRenderFixture, expanded = false, isPartial = false, width = 200) =>
  renderSubagentResult({ details: normalizeDetails(details) }, { expanded, isPartial }).render(width).map(line => line.trimEnd()).join("\n");

test("call titles summarize action-specific input counts", () => {
  assert.equal(renderCall({ action: "spawn", spawns: [{}, {}] }), "subagent spawn  2 tasks");
  assert.equal(renderCall({ action: "resume", resumes: [{}] }), "subagent resume  1 task");
  assert.equal(renderCall({ action: "steer", messages: [{}, {}] }), "subagent steer  2 messages");
  assert.equal(renderCall({ action: "cancel", subagentIds: ["one", "two"] }), "subagent cancel  2 subagents");
  assert.equal(renderCall({ action: "inspect", subagentIds: ["one"] }), "subagent inspect  1 subagent");
  assert.equal(renderCall({ action: "join", subagentIds: ["one", "two"] }), "subagent join  2 subagents");
  assert.equal(renderCall({ action: "remove", subagentIds: ["one"] }), "subagent remove  1 subagent");
  assert.equal(renderCall({ action: "agents" }), "subagent agents");
  assert.equal(
    lines(renderSubagentCall({ action: "spawn" }, { bold: text => `<b>${text}</b>` })),
    "<b>subagent</b> spawn",
  );
});

test("spawn uses outcome-first collapsed output and tagged delegation blocks when expanded", () => {
  const details: LegacyRenderFixture = {
    action: "spawn",
    tasks: [
      { inputIndex: 0, kind: "spawn", agent: "scout", label: "auth map", prompt: "Map auth.", subagentId: "quiet-otter" as any },
      { inputIndex: 1, kind: "spawn", agent: "reviewer", label: "risk review", prompt: "Review risks.", subagentId: "amber-fox" as any },
    ],
  };

  assert.equal(renderResult(details), [
    "✓ Started 2 new subagents",
    "  auth map · risk review",
  ].join("\n"));
  assert.equal(renderResult(details, true), [
    "→ auth map · scout · spawn",
    "  Map auth.",
    "  started · subagent quiet-otter",
    "",
    "→ risk review · reviewer · spawn",
    "  Review risks.",
    "  started · subagent amber-fox",
  ].join("\n"));
});

test("steer renders receipts and inspect renders bounded activity", () => {
  const steer: LegacyRenderFixture = {
    action: "steer",
    tasks: [{ inputIndex: 0, kind: "steer", agent: "scout", prompt: "Focus tests.", subagentId: "quiet-otter" as any, steer: { id: 1, state: "queued", acceptedAt: 1 } }],
  };
  assert.equal(renderResult(steer), "✓ Steered 1 subagent\n  scout");
  assert.match(renderResult(steer, true), /scout · steer[\s\S]*Focus tests\.[\s\S]*steered[\s\S]*steer #1 queued/);

  const inspect: LegacyRenderFixture = {
    action: "inspect",
    runs: [{
      subagentId: "quiet-otter" as any,
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
  assert.equal(renderResult(inspect), "✓ Inspected 1 subagent · 1 running\n  scout");
  assert.match(renderResult(inspect, true), /running · thinking[\s\S]*\[partial\] Checking tests\.[\s\S]*read\(test.ts\) · completed[\s\S]*steer #1 · processed/);
});

test("inspect renders terminal error diagnostics in expanded mode", () => {
  const inspect: LegacyRenderFixture = {
    action: "inspect",
    runs: [{
      subagentId: "quiet-otter" as any,
      agent: "scout",
      status: "failed",
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
  const cancel: LegacyRenderFixture = {
    action: "cancel",
    runs: [
      { subagentId: "quiet-otter", status: "cancelled" },
      { subagentId: "not-an-id", error: "invalid subagentId format" },
    ],
  };

  assert.equal(renderResult(cancel), "✓ Cancelled 1 subagent · 1 error\n  quiet-otter · not-an-id");
  assert.match(renderResult(cancel, true), /quiet-otter · cancelled[\s\S]*not-an-id · not cancelled[\s\S]*invalid subagentId format/);
});

test("inspect renders per-target errors without hiding the result", () => {
  const inspect: LegacyRenderFixture = {
    action: "inspect",
    runs: [{ subagentId: "not-an-id", error: "invalid subagentId format" }],
  };

  assert.equal(renderResult(inspect), "✓ Inspected 1 target · 1 error\n  not-an-id");
  assert.match(renderResult(inspect, true), /not-an-id · not inspected[\s\S]*invalid subagentId format/);
});

test("agents render configuration tags in expanded mode", () => {
  const details: LegacyRenderFixture = {
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

test("list renders canonical statuses and descendant context", () => {
  const details: LegacyRenderFixture = {
    action: "list",
    conversations: [
      {
        subagentId: "quiet-otter" as any,
        agent: "scout",
        label: "auth map",
        status: "running",
        availableActions: ["steer", "cancel", "inspect", "join"],
        descendants: [{ subagentId: "small-fox" as any, agent: "reviewer", label: "nested review", status: "completed" }],
      },
      {
        subagentId: "amber-fox" as any,
        agent: "reviewer",
        label: "risk review",
        status: "completed",
        joined: true,
        availableActions: ["resume", "inspect", "join", "remove"],
        descendants: [],
      },
    ],
  };
  assert.equal(renderResult(details), "✓ Found 2 subagents · 1 running · 1 completed\n  auth map · risk review");
  assert.equal(renderResult(details, true), [
    "● auth map · scout · running",
    "  subagent quiet-otter",
    "  ╰─ ✓ nested review · reviewer · completed",
    "",
    "✓ risk review · reviewer · completed",
    "  subagent amber-fox · joined",
  ].join("\n"));
});

test("list renders an empty canonical response", () => {
  assert.equal(renderResult({ response: { action: "list", results: [] } }), "✓ No subagents found");
});

test("join renders target errors without conversation identities", () => {
  const details: LegacyRenderFixture = {
    action: "join",
    runs: [{ subagentId: "not-an-id" as any, status: "failed", error: "invalid subagentId format" }],
  };
  assert.equal(renderResult(details, true), [
    "× not-an-id · failed",
    "  subagent not-an-id",
    "",
    "  invalid subagentId format",
  ].join("\n"));
});

test("join distinguishes partial waits and terminal child errors", () => {
  const details: LegacyRenderFixture = {
    action: "join",
    runs: [
      { subagentId: "quiet-otter" as any, label: "auth map", status: "completed", output: "Mapped auth.", elapsedMs: 12_400, turns: 3, tokens: 24_000 },
      { subagentId: "calm-wren" as any, label: "test audit", status: "failed", error: "Child failed.", elapsedMs: 950, turns: 1, tokens: 800 },
    ],
  };
  const partial: LegacyRenderFixture = {
    action: "join",
    runs: [
      details.runs[0],
      { subagentId: "calm-wren" as any, label: "test audit", status: "running", elapsedMs: 950, turns: 1, tokens: 800 },
    ],
  };
  assert.equal(renderResult(partial, false, true), [
    "✓ auth map · completed · 12s · 3 turns · 24k tokens",
    "● test audit · running · 950ms · 1 turn · 800 tokens",
    "  waiting for result",
  ].join("\n"));
  assert.equal(renderResult(details, true), [
    "✓ auth map · completed · 12s · 3 turns · 24k tokens",
    "  subagent quiet-otter",
    "",
    "  Mapped auth.",
    "",
    "× test audit · failed · 950ms · 1 turn · 800 tokens",
    "  subagent calm-wren",
    "",
    "  Child failed.",
  ].join("\n"));
});

test("join renders recent filtered activity, recursive groups, outcomes, and background details", () => {
  const details: LegacyRenderFixture = {
    action: "join",
    runs: [{
      subagentId: "root-conversation" as any,
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
        { status: "completed", toolCallId: "represented-join", targets: [{ subagentId: "c1" as any, label: "child", agent: "scout", status: "completed" }] },
        { status: "completed", targets: [{ subagentId: "c1" as any, label: "child", agent: "scout", status: "failed", error: "target failed" }] },
        { status: "running", targets: [{ subagentId: "c2" as any, label: "branch", status: "running", activity: [{ tool: "read", summary: "nested" }], joins: [{ status: "running", targets: [{ subagentId: "c3" as any, label: "leaf", agent: "reviewer", status: "running" }] }] }] },
      ],
      background: [{ ownerLabel: "root task", entries: [
        { subagentId: "bg-c1" as any, label: "watcher", status: "running" },
        { subagentId: "bg-c2" as any, label: "done bg", status: "completed", detachedAtFinal: true },
      ] }],
    }],
  };
  const collapsed = renderResult(details);
  assert.match(collapsed, /subagent join\(1 subagent\) · 5 total tool calls/);
  assert.doesNotMatch(collapsed, /too old|read\(a\)|grep\(b\)|bash\(c\)/);
  assert.match(collapsed, /✓ joined 1 · child[\s\S]*✓ joined 1 · child/);
  assert.match(collapsed, /╰─ ● branch · running[\s\S]*subagent join\(1 subagent\) · 1 total tool call[\s\S]*╰─ ● leaf · reviewer · running/);
  assert.doesNotMatch(collapsed, /read\(nested\)/);
  assert.match(collapsed, /background · 1 active · 1 completed/);
  assert.doesNotMatch(collapsed, /bg-r2|detached at final/);

  const expanded = renderResult(details, true);
  assert.match(expanded, /Investigate the whole system\./);
  assert.match(expanded, /subagent bg-c2 · detached at final/);
});

test("join trees color status markers and target statuses semantically", () => {
  const details: LegacyRenderFixture = {
    action: "join",
    runs: [{
      subagentId: "root-c" as any,
      label: "root",
      status: "running",
      joins: [{
        status: "completed",
        targets: [{
          subagentId: "child-c" as any,
          label: "child",
          agent: "scout",
          status: "completed",
          activity: [{ tool: "read" }],
        }, {
          subagentId: "sibling-c" as any,
          label: "sibling",
          status: "completed",
        }],
      }],
    }],
  };
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as any;
  const rendered = lines(renderSubagentResult({ details: normalizeDetails(details) }, { expanded: true }, theme));

  assert.match(rendered, /<success>✓<\/success> <muted>joined 2 · child, sibling<\/muted>/);
  assert.match(rendered, /<muted>├─<\/muted> <success>✓<\/success> <text>child<\/text><muted> · scout<\/muted> <muted>·<\/muted> <success>completed<\/success>/);
  assert.match(rendered, /<muted>│<\/muted>\s+<muted>read<\/muted>/);
});

test("join activity is newest-first and reports hidden tool calls", () => {
  const details: LegacyRenderFixture = {
    action: "join",
    runs: [{
      subagentId: "root-c" as any,
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
    subagentId: "root-c" as any, label: "finished", status: "completed", output: "Root answer.", prompt: "Full prompt.",
    activity: [{ tool: "read", summary: "history" }],
    joins: [{ status: "completed", targets: [{ subagentId: "child-c" as any, label: "child", status: "completed", output: "SECRET CHILD ANSWER" }] }],
  }] } as unknown as SubagentToolDetails;
  assert.equal(renderResult(details), "✓ finished · completed");
  const expanded = renderResult(details, true);
  assert.match(expanded, /Full prompt\.|read\(history\)|✓ joined 1 · child|child · completed/);
  assert.doesNotMatch(expanded, /SECRET CHILD ANSWER/);
});

test("expanded terminal joins retain recursive history, node-local filtering, and detached backgrounds", () => {
  const details: LegacyRenderFixture = {
    action: "join",
    runs: [{
      subagentId: "root-c" as any,
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
          subagentId: "child-c" as any,
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
            targets: [{ subagentId: "leaf-c" as any, label: "leaf", status: "completed" }],
          }],
          background: [{ ownerLabel: "child", entries: [{
            subagentId: "background-c" as any,
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
  assert.match(expanded, /subagent background-c · detached at final/);
  assert.match(expanded, /parent activity survives/);
  assert.doesNotMatch(expanded, /root represented join|child represented join/);
});

test("expanded joins order and separate sections while preserving indentation across wraps", () => {
  const details: LegacyRenderFixture = {
    action: "join",
    runs: [{
      subagentId: "root-c" as any,
      label: "wrapped",
      status: "completed",
      prompt: "Prompt words that wrap onto another line.",
      activity: [{ tool: "read", summary: "Tool summary words that also wrap." }],
      output: "Result words that wrap onto another line.",
    }],
  };

  assert.equal(renderResult(details, true, false, 24), [
    "✓ wrapped · completed",
    "  subagent root-c",
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
  const details: LegacyRenderFixture = {
    action: "remove",
    removed: 2,
    subagentIds: ["quiet-otter", "amber-fox"] as any,
    errors: [{ subagentId: "busy-newt", error: "Subagent busy-newt is active. Cancel it before removal." }],
  };
  assert.equal(renderResult(details), "✓ Removed 2 subagents · 1 error\n  quiet-otter · amber-fox");
  assert.match(renderResult(details, true), /quiet-otter · removed[\s\S]*amber-fox · removed[\s\S]*busy-newt · not removed[\s\S]*Cancel it/);
});

test("remove rendering preserves the root subtree order for overlapping targets", () => {
  const details = {
    response: {
      action: "remove" as const,
      results: [
        { ok: true as const, removedIds: ["first-child" as any] },
        { ok: true as const, removedIds: ["second-child" as any, "first-child" as any, "root" as any] },
      ],
    },
  } as SubagentToolDetails;

  assert.equal(renderResult(details), "✓ Removed 3 subagents\n  second-child · first-child · root");
});

test("errors render their message instead of structured output", () => {
  const details: LegacyRenderFixture = { action: "error", requestedAction: "join", message: "Unknown run." };
  assert.equal(renderResult(details), "Unknown run.");
});
