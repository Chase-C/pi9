import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";

const baseCtx = () => ({ cwd: process.cwd(), hasUI: false } as any);

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("subagent action=results delegates to manager.backgroundResults and returns a background-results view", async () => {
  const calls: any[] = [];
  const fakeManager = {
    listSessions(): any[] { return []; },
    async backgroundResults(sessionIds: string[], options: any) {
      calls.push({ sessionIds, options });
      return [{ sessionId: "s1", ready: true, result: { agent: "helper", prompt: "p", status: "completed", output: "ok", resumable: false, resumed: false } }];
    },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const result = await tool.execute("tool-call", { action: "results", sessionIds: ["s1"] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [{ sessionIds: ["s1"], options: { remove: false } }]);
  assert.equal(result.details.view, "background-results");
  assert.equal(result.details.results.length, 1);
  assert.equal(result.details.results[0].ready, true);
});

test("subagent action=results forwards the remove flag to manager.backgroundResults", async () => {
  const calls: any[] = [];
  const fakeManager = {
    listSessions(): any[] { return []; },
    async backgroundResults(sessionIds: string[], options: any) {
      calls.push({ sessionIds, options });
      return [];
    },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  await tool.execute("tool-call", { action: "results", sessionIds: ["s1", "s2"], remove: true }, undefined, undefined, baseCtx());

  assert.deepEqual(calls, [{ sessionIds: ["s1", "s2"], options: { remove: true } }]);
});

test("subagent action=results keeps isError false when entries include per-id errors", async () => {
  const fakeManager = {
    listSessions(): any[] { return []; },
    async backgroundResults() {
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
      async backgroundResults() { calls += 1; return []; },
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
        async backgroundResults() { calls += 1; return []; },
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
      async backgroundResults() { calls += 1; return []; },
    },
  });

  const result = await tool.execute("tool-call", { action: "results", sessionIds: [""] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /sessionIds must be an array of non-empty strings/);
  assert.equal(calls, 0);
});
