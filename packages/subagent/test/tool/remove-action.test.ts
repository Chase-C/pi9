import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";

const baseCtx = () => ({ cwd: process.cwd(), hasUI: false } as any);

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("subagent renderer for remove-summary shows the removed count collapsed and omits aborted when zero", () => {
  const tool = registerExtension();

  const passthroughTheme = { fg: (_color: string, text: string) => text };
  const details = { view: "remove-summary", summary: { removed: 2, aborted: 0, sessionIds: ["s1", "s2"], errors: [] } };
  const component = tool.renderResult(
    { content: [{ type: "text", text: JSON.stringify(details) }], details },
    { expanded: false },
    passthroughTheme,
  );
  const rendered = component.render(120).join("\n");

  assert.match(rendered, /Removed 2 sessions/);
  assert.doesNotMatch(rendered, /aborted/);
  assert.doesNotMatch(rendered, /errors/);
});

test("subagent renderer for remove-summary appends aborted and errors segments collapsed when non-zero", () => {
  const tool = registerExtension();

  const passthroughTheme = { fg: (_color: string, text: string) => text };
  const details = {
    view: "remove-summary",
    summary: { removed: 1, aborted: 1, sessionIds: ["s1"], errors: [{ sessionId: "s2", error: "Unknown subagent session: s2" }] },
  };
  const component = tool.renderResult(
    { content: [{ type: "text", text: JSON.stringify(details) }], details },
    { expanded: false },
    passthroughTheme,
  );
  const rendered = component.render(120).join("\n");

  assert.match(rendered, /Removed 1 session/);
  assert.match(rendered, /aborted 1/);
  assert.match(rendered, /1 error/);
});

test("subagent renderer for remove-summary lists each removed sessionId and error when expanded", () => {
  const tool = registerExtension();

  const passthroughTheme = { fg: (_color: string, text: string) => text };
  const details = {
    view: "remove-summary",
    summary: { removed: 2, aborted: 1, sessionIds: ["s1", "s2"], errors: [{ sessionId: "unknown", error: "Unknown subagent session: unknown" }] },
  };
  const component = tool.renderResult(
    { content: [{ type: "text", text: JSON.stringify(details) }], details },
    { expanded: true },
    passthroughTheme,
  );
  const rendered = component.render(120).join("\n");

  assert.match(rendered, /s1/);
  assert.match(rendered, /s2/);
  assert.match(rendered, /Errors:/);
  assert.match(rendered, /Unknown subagent session: unknown/);
});

test("subagent action=remove returns a remove-summary view with the manager.remove payload", async () => {
  const removeCalls: any[] = [];
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    async remove(args: any) {
      removeCalls.push(args);
      return { removed: 1, aborted: 0, sessionIds: ["s1"], errors: [] };
    },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const result = await tool.execute("tool-call", { action: "remove", sessionIds: ["s1"] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.deepEqual(removeCalls, [{ sessionIds: ["s1"] }]);
  assert.equal(result.details.view, "remove-summary");
  assert.deepEqual(result.details.summary, { removed: 1, aborted: 0, sessionIds: ["s1"], errors: [] });
});

test("subagent action=remove keeps isError false when manager.remove reports per-id errors", async () => {
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    async remove() {
      return { removed: 0, aborted: 0, sessionIds: [], errors: [{ sessionId: "unknown", error: "Unknown subagent session: unknown" }] };
    },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const result = await tool.execute("tool-call", { action: "remove", sessionIds: ["unknown"] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.deepEqual(result.details.summary.errors, [{ sessionId: "unknown", error: "Unknown subagent session: unknown" }]);
});

test("subagent action=remove requires explicit sessionIds", async () => {
  let removeCalls = 0;
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: { sessions: [], listSessions() { return this.sessions; }, async remove() { removeCalls += 1; throw new Error("should not remove"); } },
  });

  const result = await tool.execute("tool-call", { action: "remove" }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /remove requires sessionIds\./);
  assert.equal(removeCalls, 0);
});

test("subagent action=remove rejects malformed or empty sessionIds without calling manager.remove", async () => {
  for (const sessionIds of ["s1", ["s1", 42], [], ["   "]] as const) {
    let removeCalls = 0;
    const tool = registerExtension({
      agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
      agentManager: { sessions: [], listSessions() { return this.sessions; }, async remove() { removeCalls += 1; throw new Error("should not remove"); } },
    });

    const result = await tool.execute("tool-call", { action: "remove", sessionIds }, undefined, undefined, baseCtx());

    assert.equal(result.isError, true, `sessionIds=${JSON.stringify(sessionIds)}: expected error`);
    assert.match(result.content[0].text, /sessionIds must be an array of strings|sessionIds must be an array of non-empty strings|requires at least one sessionId/);
    assert.equal(removeCalls, 0);
  }
});
