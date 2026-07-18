import { test } from "vitest";
import assert from "node:assert/strict";
import { defineSubagentTool } from "../../src/tool/define-subagent-tool.js";

const settings = { runtime: { maxTasksPerRun: 1 }, display: {} } as any;
const registry = { agents: new Map(), summarizeAgent: () => "helper" } as any;

test("tool prepares settings, applies task limits, and renders simple typed content", async () => {
  let prepared = 0;
  const tool: any = defineSubagentTool({ agentManager: {} as any, agentRegistry: registry, getCurrentSettings: () => settings, prepareInvocation: async () => { prepared++; return settings; } });
  const result = await tool.execute("call", { action: "run", tasks: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }] }, undefined, undefined, {});
  assert.equal(prepared, 1); assert.equal(result.isError, true); assert.match(result.content[0].text, /Too many tasks/);
  assert.match(tool.renderResult(result, {}, {}).render(120).join("\n"), /Too many tasks/);
  assert.match(tool.renderCall({ action: "run", tasks: [{}, {}] }, {}, {}).render(120).join("\n"), /2 tasks/);
});

test("rejected mixed join releases every valid requested claim", async () => {
  let released: readonly string[] = [];
  const tool: any = defineSubagentTool({ agentManager: {} as any, agentRegistry: registry, getCurrentSettings: () => settings, prepareInvocation: async () => settings, releaseJoinClaims: ids => { released = ids; } });
  const result = await tool.execute("call", { action: "join", runIds: ["valid-run", 42] }, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.deepEqual(released, ["valid-run"]);
});

test("settings preparation failures propagate without starting manager work", async () => {
  let started = false;
  const tool: any = defineSubagentTool({ agentManager: { startRun: () => { started = true; } } as any, agentRegistry: registry, getCurrentSettings: () => settings, prepareInvocation: async () => { throw new Error("settings unavailable"); } });
  await assert.rejects(() => tool.execute("call", { action: "agents" }, undefined, undefined, {}), /settings unavailable/);
  assert.equal(started, false);
});
