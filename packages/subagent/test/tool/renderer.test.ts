import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";
import { fakeAgent } from "../helpers/fake-agent.js";

function registerExtension() {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any);
  return registeredTool;
}

const passthroughTheme = { fg: (_color: string, text: string) => text };

function titleText(tool: any, args: unknown, context?: unknown): string {
  return tool.renderCall(args, passthroughTheme, context).render(200).join("\n");
}

test("subagent tool result renderer falls back to simple text when themed rendering fails", () => {
  const tool = registerExtension();

  let component: any;
  assert.doesNotThrow(() => {
    component = tool.renderResult(
      {
        content: [{ type: "text", text: "plain fallback helper output" }],
        details: {
          view: "inventory",
          sessions: [{
            id: "s1", inputIndex: 0, createdAt: 1,
            config: { name: "helper", description: "Helper", source: "project", model: undefined, thinking: undefined, tools: undefined, resumable: false },
            status: { kind: "done", outcome: "completed", completedAt: 2 },
            activity: { turns: 1, compactions: 0, toolHistory: [] },
            usage: undefined,
          }],
        },
      },
      { expanded: true },
      { fg() { throw new Error("theme failed"); } },
    );
  });

  assert.match(component.render(120).join("\n"), /plain fallback helper output/);
});

test("subagent tool result renderer falls back to content text for unknown view shapes", () => {
  const tool = registerExtension();
  const passthroughTheme = { fg: (_color: string, text: string) => text };
  const details = { errors: ["task[0]: bad"] };

  const component = tool.renderResult(
    { content: [{ type: "text", text: JSON.stringify(details) }], details },
    { expanded: false },
    passthroughTheme,
  );
  const rendered = component.render(120).join("\n");

  assert.doesNotMatch(rendered, /No subagent sessions\./);
  assert.match(rendered, /task\[0\]: bad/);
});

test("subagent tool result renderer falls back to content text for a partial persisted payload", () => {
  const tool = registerExtension();
  const passthroughTheme = { fg: (_color: string, text: string) => text };
  // A stale/older-shape "results" envelope: right view tag, but the `results` array is absent.
  const details = { view: "results", outcomes: [{ agent: "helper", status: "completed" }] };

  const component = tool.renderResult(
    { content: [{ type: "text", text: "STALE_PAYLOAD_FALLBACK" }], details },
    { expanded: false },
    passthroughTheme,
  );
  const rendered = component.render(120).join("\n");

  assert.match(rendered, /STALE_PAYLOAD_FALLBACK/);
  assert.doesNotMatch(rendered, /completed/);
});

test("subagent tool result renderer keeps the empty-sessions message for an explicit empty sessions shape", () => {
  const tool = registerExtension();

  const component = tool.renderResult(
    { content: [{ type: "text", text: '{ "sessions": [] }' }], details: { view: "inventory", sessions: [] } },
    { expanded: false },
    { fg: (_c: string, t: string) => t },
  );

  assert.match(component.render(120).join("\n"), /No subagent sessions\./);
});

test("subagent run title shows live running/queued/finished counts and elapsed once a partial result populates state", () => {
  const tool = registerExtension();
  const context: any = { state: {} };
  const sessions = [
    fakeAgent({ id: "a", config: { name: "alpha" }, status: { kind: "running", startedAt: 1 } }),
    fakeAgent({ id: "b", config: { name: "beta" }, status: { kind: "running", startedAt: 1 } }),
    fakeAgent({ id: "c", config: { name: "gamma" }, status: { kind: "queued" } }),
    fakeAgent({ id: "d", config: { name: "delta" }, status: { kind: "completed", startedAt: 1, completedAt: 2 } }),
  ];

  tool.renderResult(
    { content: [{ type: "text", text: "" }], details: { view: "run", sessions } },
    { expanded: false, isPartial: true },
    passthroughTheme,
    context,
  );

  const title = titleText(tool, { action: "run", tasks: [{}, {}, {}, {}] }, context);

  assert.match(title, /^subagent run · 2 running · 1 queued · 1 finished · \d/);
});

test("subagent run title falls back to the task count before a live result, with or without a render context", () => {
  const tool = registerExtension();

  // No render context at all (older call sites / non-TUI re-renders): must not throw.
  assert.match(titleText(tool, { action: "run", tasks: [{}, {}, {}] }), /^subagent run · 3 tasks\s*$/);

  // Empty row-local state, before the first partial result populates a summary.
  assert.match(titleText(tool, { action: "run", tasks: [{}, {}, {}] }, { state: {} }), /^subagent run · 3 tasks\s*$/);
});

test("subagent run title omits zero running/queued counts, keeping finished and elapsed", () => {
  const tool = registerExtension();
  const context: any = { state: {} };
  const sessions = [
    fakeAgent({ id: "a", config: { name: "alpha" }, status: { kind: "completed", startedAt: 1, completedAt: 2 } }),
    fakeAgent({ id: "b", config: { name: "beta" }, status: { kind: "completed", startedAt: 1, completedAt: 2 } }),
  ];

  tool.renderResult(
    { content: [{ type: "text", text: "" }], details: { view: "run", sessions } },
    { expanded: false, isPartial: true },
    passthroughTheme,
    context,
  );

  const title = titleText(tool, { action: "run", tasks: [{}, {}] }, context);
  assert.match(title, /^subagent run · 2 finished · \d/);
  assert.doesNotMatch(title, /running|queued/);
});

test("subagent run title derives finished counts from a completed results envelope", () => {
  const tool = registerExtension();
  const context: any = { state: {} };
  const results = [
    { snapshot: fakeAgent({ id: "a", config: { name: "alpha" }, status: { kind: "completed", startedAt: 1, completedAt: 2 } }) },
    { snapshot: fakeAgent({ id: "b", config: { name: "beta" }, status: { kind: "error", startedAt: 1, completedAt: 2, error: "boom" } }) },
  ];

  tool.renderResult(
    { content: [{ type: "text", text: "" }], details: { view: "results", results } },
    { expanded: false },
    passthroughTheme,
    context,
  );

  const title = titleText(tool, { action: "run" }, context);
  assert.match(title, /^subagent run · 2 finished · /);
  assert.doesNotMatch(title, /running|queued/);
});

test("subagent run title counts the subtree through the shared state path when nested children are present", () => {
  const tool = registerExtension();
  const context: any = { state: {} };
  const root = fakeAgent({ id: "r", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const child = fakeAgent({ id: "c", parentSessionId: "r", config: { name: "child" }, createdAt: 2, status: { kind: "queued" } });
  const grandchild = fakeAgent({ id: "g", parentSessionId: "c", config: { name: "grand" }, createdAt: 3, status: { kind: "completed", startedAt: 2, completedAt: 3 } });

  tool.renderResult(
    { content: [{ type: "text", text: "" }], details: { view: "run", sessions: [root], subtree: [root, child, grandchild] } },
    { expanded: false, isPartial: true },
    passthroughTheme,
    context,
  );

  // Flat sessions alone would read "1 running"; the subtree adds the queued + finished descendants.
  assert.match(titleText(tool, { action: "run", tasks: [{}] }, context), /^subagent run · 1 running · 1 queued · 1 finished · /);
});
