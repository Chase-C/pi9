import { test } from "vitest";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SubagentRuntime } from "../../src/runtime.js";
import { defineSubagentTool } from "../../src/tool.js";

const settings = { runtime: { maxTasksPerRun: 1 }, display: {} } as any;
const registry = { agents: new Map(), summarizeAgent: () => "helper" } as any;
const runtime = new SubagentRuntime(registry);

test("description names typed action inputs without restating task unions", () => {
  const tool = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  const description = tool.description;
  assert.match(description, /Batch entries are independent; one failure does not stop valid siblings/);
  assert.match(description, /Repeated subagentIds are rejected after the first occurrence/);
  assert.match(description, /completed status means execution finished; joined means its latest result was collected/);
  assert.match(description, /list\(statuses\?, joined\?\): List direct child subagents with descendant context/);
  assert.match(description, /spawn\(spawns\)/);
  assert.match(description, /resume\(resumes\)/);
  assert.match(description, /steer\(messages\)/);
  assert.match(description, /cancel\(subagentIds\)/);
  assert.match(description, /inspect\(subagentIds\)/);
  assert.match(description, /join\(subagentIds\).*blocks while running, idempotent after/);
  assert.match(description, /remove\(subagentIds\).*inactive subagent subtrees, including unjoined results/);
  assert.doesNotMatch(description, /Spawn:|Resume:|Steer:|union|acknowledg|lifecycle|latest outcome|list\(scope|state\?/i);
  const properties = (tool.parameters as any).properties;
  assert.deepEqual(Object.keys(properties.spawns.items.properties), ["agent", "prompt", "label", "skills", "model", "thinking", "cwd"]);
  assert.deepEqual(Object.keys(properties.resumes.items.properties), ["subagentId", "prompt"]);
  assert.deepEqual(Object.keys(properties.messages.items.properties), ["subagentId", "message"]);
});

const toolCall = (arguments_: Record<string, any>) => ({
  type: "toolCall" as const,
  id: "call",
  name: "subagent",
  arguments: arguments_,
});

test("SDK validation rejects a whole batch containing a malformed task", () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => ({ runtime: { maxTasksPerRun: 2 }, display: {} }) as any,
  });
  const raw = {
    action: "spawn",
    spawns: [
      { agent: "helper", prompt: "malformed", extra: true },
      { agent: "helper", prompt: "valid" },
    ],
  };

  assert.throws(() => validateToolArguments(tool, toolCall(raw)), /Validation failed/);
});

test("SDK validation enforces the task-array minimum", () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  assert.throws(
    () => validateToolArguments(tool, toolCall({ action: "spawn", spawns: [] })),
    /Validation failed/,
  );
});

test("tool prepares settings, applies task limits, and renders simple typed content", async () => {
  let prepared = 0;
  const tool: any = defineSubagentTool({ runtime, agentRegistry: registry, prepareInvocation: async () => { prepared++; return settings; } });
  const result = await tool.execute("call", { action: "spawn", spawns: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }] }, undefined, undefined, {});
  assert.equal(prepared, 1);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "spawn",
    error: "Too many tasks (2). Max is 1.\n\nAvailable agents:\nhelper",
  });
  assert.match(tool.renderResult(result, {}, {}).render(120).join("\n"), /Too many tasks/);
  assert.match(tool.renderCall({ action: "spawn", spawns: [{}, {}] }, {}, {}).render(120).join("\n"), /2 tasks/);
});

test("unknown actions return a structured global error envelope", async () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });

  const result = await tool.execute("call", { action: "bogus" }, undefined, undefined, {});

  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "unknown",
    error: 'Unknown action: bogus. Use "agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", or "remove".',
  });
});

test("mixed join target errors remain ordered item failures", async () => {
  const tool: any = defineSubagentTool({ runtime, agentRegistry: registry, prepareInvocation: async () => settings });
  const result = await tool.execute("call", { action: "join", subagentIds: ["valid-run", "ghost-silently", 42] }, undefined, undefined, {});
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.action, "join");
  assert.deepEqual(response.summary, { requested: 3, succeeded: 0, failed: 3 });
  assert.deepEqual(response.results, [
    { ok: false, subagentId: "valid-run", error: "Invalid subagentId format: valid-run." },
    { ok: false, subagentId: "ghost-silently", error: "Invalid subagentId format: ghost-silently." },
    { ok: false, subagentId: "42", error: "Invalid subagentId format: 42." },
  ]);
});

test("settings preparation failures propagate without starting manager work", async () => {
  let started = false;
  const tool: any = defineSubagentTool({ runtime: { startRun: () => { started = true; } } as any, agentRegistry: registry, prepareInvocation: async () => { throw new Error("settings unavailable"); } });
  await assert.rejects(() => tool.execute("call", { action: "agents" }, undefined, undefined, {}), /settings unavailable/);
  assert.equal(started, false);
});
