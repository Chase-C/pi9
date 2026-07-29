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
  assert.match(description, /list\(status\?\).*grouped with their runs/);
  assert.match(description, /spawn\(spawns\)/);
  assert.match(description, /resume\(resumes\)/);
  assert.match(description, /steer\(messages\)/);
  assert.match(description, /cancel\(runIds\)/);
  assert.match(description, /inspect\(runIds\)/);
  assert.match(description, /join\(runIds\)/);
  assert.match(description, /remove\(conversationIds\).*reparented to the nearest surviving parent/);
  assert.match(description, /ordered and best-effort, not atomic/);
  assert.match(description, /failures do not roll back successful items/);
  assert.match(description, /Retry only failed items/);
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
    runtime: {} as any,
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
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => { prepared++; return settings; } });
  const result = await tool.execute("call", { action: "spawn", spawns: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }] }, undefined, undefined, {});
  assert.equal(prepared, 1);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "spawn",
    error: "Too many tasks (2). Max is 1.\n\nAvailable agents:\nhelper",
  });
  assert.match(tool.renderResult(result, {}, {}).render(120).join("\n"), /Too many tasks/);
  assert.match(tool.renderCall({ action: "spawn", spawns: [{}, {}] }, {}, {}).render(120).join("\n"), /2 tasks/);
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
    error: 'Unknown action: bogus. Use "agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", or "remove".',
  });
});

test("child terminal inspect reports its full lifecycle to shared notification hooks", async () => {
  const events: Array<{ kind: string; scope: string; toolCallId: string; value: unknown }> = [];
  const runtime = {
    inspectRuns: ([runId]: string[]) => [{
      conversationId: "amber-acorn",
      snapshot: {
        runId,
        kind: "spawn",
        prompt: "done",
        createdAt: 1,
        status: { kind: "done", outcome: "completed", completedAt: 2 },
        activity: { turns: 1, compactions: 0, toolHistory: [] },
        observerCount: 0,
        acknowledged: false,
      },
    }],
    runLineage: (runId: string) => ({ rootRunId: runId, depth: 0 }),
    conversationDisplay: () => ({ agentName: "worker" }),
    conversation: () => ({}),
  } as any;
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
    parent: { conversationId: "amber-acorn" as any, runId: () => "build-boldly" as any },
    notificationHooks: {
      beginTool: (scope, toolCallId, params) => events.push({ kind: "begin", scope, toolCallId, value: params }),
      completeTool: (scope, toolCallId, result) => events.push({ kind: "complete", scope, toolCallId, value: result }),
    },
  });

  const params = { action: "inspect", runIds: ["adapt-ably"] };
  const result = await tool.execute("call", params, undefined, undefined, {});

  assert.deepEqual(events, [
    { kind: "begin", scope: "child:build-boldly", toolCallId: "call", value: params },
    { kind: "complete", scope: "child:build-boldly", toolCallId: "call", value: result },
  ]);
});

test("mixed join target errors remain ordered item failures", async () => {
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings });
  const result = await tool.execute("call", { action: "join", runIds: ["valid-run", 42] }, undefined, undefined, {});
  assert.equal(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.action, "join");
  assert.deepEqual(response.results, [
    { ok: false, runId: "valid-run", error: "join received invalid runId format 'valid-run'." },
    { ok: false, runId: "42", error: "join received invalid runId format '42'." },
  ]);
});

test("child failures still complete shared notification hooks", async () => {
  const events: Array<{ kind: string; result?: unknown }> = [];
  const tool: any = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => { throw new Error("settings unavailable"); },
    parent: { conversationId: "amber-acorn" as any, runId: () => "build-boldly" as any },
    notificationHooks: {
      beginTool: () => events.push({ kind: "begin" }),
      completeTool: (_scope, _toolCallId, result) => events.push({ kind: "complete", result }),
    },
  });

  await assert.rejects(() => tool.execute("call", { action: "inspect", runIds: ["adapt-ably"] }, undefined, undefined, {}), /settings unavailable/);
  assert.deepEqual(events, [{ kind: "begin" }, { kind: "complete", result: undefined }]);
});

test("settings preparation failures propagate without starting manager work", async () => {
  let started = false;
  const tool: any = defineSubagentTool({ runtime: { startRun: () => { started = true; } } as any, agentRegistry: registry, prepareInvocation: async () => { throw new Error("settings unavailable"); } });
  await assert.rejects(() => tool.execute("call", { action: "agents" }, undefined, undefined, {}), /settings unavailable/);
  assert.equal(started, false);
});
