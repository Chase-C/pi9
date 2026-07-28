import { test } from "vitest";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { defineSubagentTool } from "../../src/tool.js";

const settings = { runtime: { maxTasksPerRun: 1 }, display: {} } as any;
const registry = { agents: new Map(), summarizeAgent: () => "helper" } as any;

test("description associates flat-schema properties with actions and task kinds", () => {
  const tool = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  const description = tool.description;
  assert.match(description, /list\(status\?\)/);
  assert.match(description, /dispatch\(tasks\)/);
  assert.match(description, /inspect\(runIds\)/);
  assert.match(description, /join\(runIds\)/);
  assert.match(description, /remove\(conversationIds\)/);
  assert.match(description, /Spawn: \{ agent, prompt/);
  assert.match(description, /Resume: \{ conversationId, prompt \}/);
  assert.match(description, /Steer: \{ runId, prompt \}/);
  const taskProperties = (tool.parameters as any).properties.tasks.items.properties;
  assert.ok(taskProperties.agent);
  assert.ok(taskProperties.conversationId);
  assert.ok(taskProperties.runId);
  assert.ok(taskProperties.prompt);
});

const toolCall = (arguments_: Record<string, any>) => ({
  type: "toolCall" as const,
  id: "call",
  name: "subagent",
  arguments: arguments_,
});

test("SDK validation rejects a whole batch containing a malformed task", () => {
  const tool: any = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => ({ runtime: { maxTasksPerRun: 2 }, display: {} }) as any,
  });
  const raw = {
    action: "dispatch",
    tasks: [
      { agent: "helper", prompt: "malformed", extra: true },
      { agent: "helper", prompt: "valid" },
    ],
  };

  assert.throws(() => validateToolArguments(tool, toolCall(raw)), /Validation failed/);
});

test("SDK validation enforces the task-array minimum", () => {
  const tool: any = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  assert.throws(
    () => validateToolArguments(tool, toolCall({ action: "dispatch", tasks: [] })),
    /Validation failed/,
  );
});

test("tool prepares settings, applies task limits, and renders simple typed content", async () => {
  let prepared = 0;
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => { prepared++; return settings; } });
  const result = await tool.execute("call", { action: "dispatch", tasks: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }] }, undefined, undefined, {});
  assert.equal(prepared, 1); assert.equal(result.isError, true); assert.match(result.content[0].text, /Too many tasks/);
  assert.match(tool.renderResult(result, {}, {}).render(120).join("\n"), /Too many tasks/);
  assert.match(tool.renderCall({ action: "dispatch", tasks: [{}, {}] }, {}, {}).render(120).join("\n"), /2 tasks/);
});

test("rejected mixed join releases every valid requested claim", async () => {
  let released: readonly string[] = [];
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings, releaseJoinClaims: ids => { released = ids; } });
  const result = await tool.execute("call", { action: "join", runIds: ["valid-run", 42] }, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.deepEqual(released, ["valid-run"]);
});

test("settings preparation failures propagate without starting manager work", async () => {
  let started = false;
  const tool: any = defineSubagentTool({ runtime: { startRun: () => { started = true; } } as any, agentRegistry: registry, prepareInvocation: async () => { throw new Error("settings unavailable"); } });
  await assert.rejects(() => tool.execute("call", { action: "agents" }, undefined, undefined, {}), /settings unavailable/);
  assert.equal(started, false);
});
