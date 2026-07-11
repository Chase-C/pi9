import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";
import { fakeAgent } from "../helpers/fake-agent.js";

const baseCtx = () => ({ cwd: process.cwd(), hasUI: false } as any);

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("subagent action=results delegates to manager.backgroundResults and returns a results view", async () => {
  const calls: any[] = [];
  const fakeManager = {
    listSessions(): any[] { return []; },
    backgroundResults(sessionIds: string[]) {
      calls.push({ sessionIds });
      return [{ snapshot: fakeAgent({ id: "s1", config: { name: "helper" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }) }];
    },
    async remove() { throw new Error("remove should not be called without params.remove"); },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const result = await tool.execute("tool-call", { action: "results", sessionIds: ["s1"] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [{ sessionIds: ["s1"] }]);
  assert.equal(result.details.view, "results");
  assert.equal(result.details.results.length, 1);
  assert.equal(result.details.results[0].snapshot.status.kind, "done");
});

test("subagent action=results with remove:true follows backgroundResults with a manager.remove of the terminal ids", async () => {
  const fetchCalls: any[] = [];
  const removeCalls: any[] = [];
  const fakeManager = {
    listSessions(): any[] { return []; },
    backgroundResults(sessionIds: string[]) {
      fetchCalls.push({ sessionIds });
      return [
        { snapshot: fakeAgent({ id: "s1", config: { name: "helper" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }) },
        { snapshot: fakeAgent({ id: "s2", config: { name: "helper" }, status: { kind: "running", startedAt: 1 } }) },
      ];
    },
    async remove(args: any) {
      removeCalls.push(args);
      return { removed: 1, aborted: 0, sessionIds: args.sessionIds, errors: [] };
    },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  await tool.execute("tool-call", { action: "results", sessionIds: ["s1", "s2"], remove: true }, undefined, undefined, baseCtx());

  assert.deepEqual(fetchCalls, [{ sessionIds: ["s1", "s2"] }]);
  assert.deepEqual(removeCalls, [{ sessionIds: ["s1"] }], "only the terminal/ready entry is swept");
});

test("subagent action=results with remove:true refreshes the widget after sweeping terminal sessions", async () => {
  const widgets: unknown[][] = [];
  let sessions = [fakeAgent({ id: "s1", dispatch: "background", status: { kind: "completed", startedAt: 1, completedAt: 2 } })];
  const fakeManager = {
    listSessions() { return sessions; },
    backgroundResults() { return [{ snapshot: sessions[0] }]; },
    async remove() { sessions = []; return { removed: 1, aborted: 0, sessionIds: ["s1"], errors: [] }; },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  await tool.execute(
    "tool-call",
    { action: "results", sessionIds: ["s1"], remove: true },
    undefined,
    undefined,
    { ...baseCtx(), hasUI: true, ui: { setWidget: (...args: unknown[]) => widgets.push(args) } },
  );

  assert.ok(widgets.length > 0);
  assert.equal(widgets.at(-1)?.[1], undefined);
});

test("subagent action=results keeps isError false when entries include per-id errors", async () => {
  const fakeManager = {
    listSessions(): any[] { return []; },
    backgroundResults() {
      return [{ sessionId: "nope", error: "Unknown subagent session: nope" }];
    },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const result = await tool.execute("tool-call", { action: "results", sessionIds: ["nope"] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].error, "Unknown subagent session: nope");
});

test("subagent action=results rejects an empty sessionIds array without calling manager.backgroundResults", async () => {
  let calls = 0;
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: {
      sessions: [],
      listSessions() { return this.sessions; },
      backgroundResults() { calls += 1; return []; },
    },
  });

  const result = await tool.execute("tool-call", { action: "results", sessionIds: [] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /results requires at least one sessionId/);
  assert.equal(calls, 0);
});

test("subagent action=results rejects malformed sessionIds (non-array or non-string entries) without calling manager.backgroundResults", async () => {
  for (const sessionIds of ["s1", ["s1", 7]] as const) {
    let calls = 0;
    const tool = registerExtension({
      agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
      agentManager: {
        sessions: [],
        listSessions() { return this.sessions; },
        backgroundResults() { calls += 1; return []; },
      },
    });

    const result = await tool.execute("tool-call", { action: "results", sessionIds }, undefined, undefined, baseCtx());

    assert.equal(result.isError, true, `sessionIds=${JSON.stringify(sessionIds)}: expected error`);
    assert.match(result.content[0].text, /sessionIds must be an array of strings/);
    assert.equal(calls, 0);
  }
});

test("subagent action=results rejects empty-string sessionIds without calling manager.backgroundResults", async () => {
  let calls = 0;
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: {
      sessions: [],
      listSessions() { return this.sessions; },
      backgroundResults() { calls += 1; return []; },
    },
  });

  const result = await tool.execute("tool-call", { action: "results", sessionIds: [""] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /sessionIds must be an array of non-empty strings/);
  assert.equal(calls, 0);
});
