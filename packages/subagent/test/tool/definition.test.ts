import { test } from "vitest";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { defineSubagentTool } from "../../src/tool.js";

const settings = { runtime: { maxTasksPerRun: 1 }, display: {} } as any;
const registry = { agents: new Map(), summarizeAgent: () => "helper" } as any;

test("description names typed action inputs without restating task unions", () => {
  const tool = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  const description = tool.description;
  assert.match(description, /Conversation IDs use adjective-noun form; run IDs use verb-adverb form\./);
  assert.match(description, /Results use \{ action, ok, data \} on success or \{ action, ok, error \} on global failure\./);
  assert.match(description, /list\(status\?\)/);
  assert.match(description, /run\(spawns\?, resumes\?\)/);
  assert.match(description, /steer\(messages\)/);
  assert.match(description, /cancel\(runIds\)/);
  assert.match(description, /inspect\(runIds\)/);
  assert.match(description, /join\(runIds\)/);
  assert.match(description, /remove\(conversationIds\)/);
  assert.doesNotMatch(description, /Spawn:|Resume:|Steer:|union/);
  const properties = (tool.parameters as any).properties;
  assert.deepEqual(Object.keys(properties.spawns.items.properties), ["agent", "prompt", "label", "skills", "model", "thinking", "cwd"]);
  assert.deepEqual(Object.keys(properties.resumes.items.properties), ["conversationId", "prompt"]);
  assert.deepEqual(Object.keys(properties.messages.items.properties), ["runId", "message"]);
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
    action: "run",
    spawns: [
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
    () => validateToolArguments(tool, toolCall({ action: "run", spawns: [] })),
    /Validation failed/,
  );
});

test("tool prepares settings, applies task limits, and renders simple typed content", async () => {
  let prepared = 0;
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => { prepared++; return settings; } });
  const result = await tool.execute("call", { action: "run", spawns: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }] }, undefined, undefined, {});
  assert.equal(prepared, 1);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "run",
    ok: false,
    error: "Too many tasks (2). Max is 1.\n\nAvailable agents:\nhelper",
  });
  assert.match(tool.renderResult(result, {}, {}).render(120).join("\n"), /Too many tasks/);
  assert.match(tool.renderCall({ action: "run", spawns: [{}, {}] }, {}, {}).render(120).join("\n"), /2 tasks/);
});

test("unknown actions return a structured global error envelope", async () => {
  const tool: any = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });

  const result = await tool.execute("call", { action: "bogus" }, undefined, undefined, {});

  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "unknown",
    ok: false,
    error: 'Unknown action: bogus. Use "agents", "list", "run", "steer", "cancel", "inspect", "join", or "remove".',
  });
});

test("mixed join target errors still release every valid requested claim", async () => {
  let released: readonly string[] = [];
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings, releaseJoinClaims: ids => { released = ids; } });
  const result = await tool.execute("call", { action: "join", runIds: ["valid-run", 42] }, undefined, undefined, {});
  assert.equal(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.action, "join");
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.runs.map((entry: any) => entry.runId), ["valid-run", "42"]);
  assert.deepEqual(released, ["valid-run"]);
});

test("settings preparation failures propagate without starting manager work", async () => {
  let started = false;
  const tool: any = defineSubagentTool({ runtime: { startRun: () => { started = true; } } as any, agentRegistry: registry, prepareInvocation: async () => { throw new Error("settings unavailable"); } });
  await assert.rejects(() => tool.execute("call", { action: "agents" }, undefined, undefined, {}), /settings unavailable/);
  assert.equal(started, false);
});
