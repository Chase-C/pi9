import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";

function registerExtension() {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any);
  return registeredTool;
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

test("subagent tool result renderer keeps the empty-sessions message for an explicit empty sessions shape", () => {
  const tool = registerExtension();

  const component = tool.renderResult(
    { content: [{ type: "text", text: '{ "sessions": [] }' }], details: { view: "inventory", sessions: [] } },
    { expanded: false },
    { fg: (_c: string, t: string) => t },
  );

  assert.match(component.render(120).join("\n"), /No subagent sessions\./);
});
