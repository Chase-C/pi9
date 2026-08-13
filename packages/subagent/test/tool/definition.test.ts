import { test } from "vitest";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SubagentRuntime } from "../../src/runtime.js";
import { defineSubagentTool } from "../../src/tool.js";

const settings = { runtime: { maxTasksPerCall: 1 }, display: {} } as any;
const registry = { agents: new Map(), summarizeAgent: () => "helper" } as any;
const runtime = new SubagentRuntime(registry);

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
    prepareInvocation: async () => ({ runtime: { maxTasksPerCall: 2 }, display: {} }) as any,
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
  const result = await tool.execute("call", { action: "spawn", spawns: [
    { agent: "a", prompt: "1", label: "One" },
    { agent: "a", prompt: "2", label: "Two" },
  ] }, undefined, undefined, {});
  assert.equal(prepared, 1);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "spawn",
    error: "Too many tasks (2). Max is 1.\n\nAvailable agents:\nhelper",
  });
  assert.match(tool.renderResult(result, {}, {}).render(120).join("\n"), /Too many tasks/);
  assert.match(tool.renderCall({ action: "spawn", spawns: [{}, {}] }, {}, {}).render(120).join("\n"), /2 tasks/);
});

test("tool descriptions define model collection and initiator receipt semantics", () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });

  assert.match(tool.description, /list\(statuses\?, collected\?\).*model's collection receipt/);
  assert.match(tool.description, /resume\(resumes\).*prior generation initiator's collection receipt/);
  assert.match(tool.description, /join\(subagentIds\).*Wait for completion and collect each result for the model/);
  assert.doesNotMatch(tool.description, /\b(?:joined|unjoined)\b/);
});

test("unknown actions return a structured global error envelope marked as an error", async () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });

  const result = await tool.execute("call", { action: "bogus" }, undefined, undefined, {});

  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "unknown",
    error: 'Unknown action: bogus. Use "agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", or "remove".',
  });
});

test("plausible unknown join IDs use not-found wording while malformed IDs remain invalid", async () => {
  const tool: any = defineSubagentTool({ runtime, agentRegistry: registry, prepareInvocation: async () => settings });
  const result = await tool.execute("call", { action: "join", subagentIds: ["plausible-target", "ghost-silently", 42] }, undefined, undefined, {});
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.action, "join");
  assert.deepEqual(response.summary, { requested: 3, succeeded: 0, failed: 3 });
  assert.deepEqual(response.results, [
    { ok: false, subagentId: "plausible-target", error: "Subagent plausible-target was not found." },
    { ok: false, subagentId: "ghost-silently", error: "Subagent ghost-silently was not found." },
    { ok: false, subagentId: "42", error: "Invalid subagentId format: 42." },
  ]);
});

test("settings preparation failures propagate without starting manager work", async () => {
  let started = false;
  const tool: any = defineSubagentTool({ runtime: { startTasks: () => { started = true; } } as any, agentRegistry: registry, prepareInvocation: async () => { throw new Error("settings unavailable"); } });
  await assert.rejects(() => tool.execute("call", { action: "agents" }, undefined, undefined, {}), /settings unavailable/);
  assert.equal(started, false);
});
