import { test } from "vitest";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { SubagentParams, TaskSchema, parseSubagentInvocation, parseTask, SUBAGENT_ACTIONS } from "../src/schema.js";

const conversationId = "amber-acorn";
const runId = "adapt-ably";

test("public schema exposes only redesigned actions and fields", () => {
  assert.deepEqual(SUBAGENT_ACTIONS, ["agents", "list", "run", "join", "remove"]);
  assert.equal(Check(SubagentParams, { action: "agents" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "work" }), true);
  assert.equal(Check(TaskSchema, { conversationId, prompt: "continue" }), true);
});

test("spawn fields are optional where agreed and preserved", () => {
  assert.deepEqual(parseTask({ agent: "helper", prompt: "work", label: "label", skills: ["review"], model: "m", thinking: "high", cwd: "sub" }),
    { kind: "spawn", agent: "helper", prompt: "work", label: "label", skills: ["review"], model: "m", thinking: "high", cwd: "sub" });
  assert.deepEqual(parseTask({ agent: "helper", prompt: "work" }), { kind: "spawn", agent: "helper", prompt: "work" });
});

test("resume accepts conversationId and prompt only", () => {
  assert.deepEqual(parseTask({ conversationId, prompt: "next" }), { kind: "resume", conversationId, prompt: "next" });
  for (const field of ["label", "skills", "model", "thinking", "cwd"]) {
    const parsed = parseTask({ conversationId, prompt: "next", [field]: field === "skills" ? [] : "x" });
    assert.ok("error" in parsed); assert.match(parsed.error, new RegExp(`rejects ${field}`));
  }
});

test("tasks validate shape, blanks, overrides, and wrong ID kind", () => {
  for (const task of [null, { prompt: "x" }, { agent: "", prompt: "x" }, { agent: "a", prompt: " " }, { agent: "a", prompt: "x", skills: [""] }, { agent: "a", prompt: "x", thinking: "extreme" }]) assert.ok("error" in parseTask(task));
  const wrong = parseTask({ conversationId: runId, prompt: "next" }); assert.ok("error" in wrong); assert.match(wrong.error, /run ID is not accepted/);
});

test("invocations parse every action without aliases", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "agents" }), { action: "agents" });
  assert.deepEqual(parseSubagentInvocation({ action: "list", status: ["running"] }), { action: "list", status: ["running"] });
  assert.deepEqual(parseSubagentInvocation({ action: "run", tasks: [{ agent: "helper", prompt: "x" }] }), { action: "run", tasks: [{ kind: "spawn", agent: "helper", prompt: "x" }] });
  assert.deepEqual(parseSubagentInvocation({ action: "join", runIds: [runId] }), { action: "join", runIds: [runId] });
  assert.deepEqual(parseSubagentInvocation({ action: "remove", conversationIds: [conversationId] }), { action: "remove", conversationIds: [conversationId] });
});

test("whole invocation validation covers limits, IDs, status, and required batches", () => {
  assert.ok("error" in parseSubagentInvocation({}));
  assert.ok("error" in parseSubagentInvocation({ action: "list", status: ["stale"] }));
  assert.ok("error" in parseSubagentInvocation({ action: "run", tasks: [] }));
  assert.match((parseSubagentInvocation({ action: "run", tasks: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }] }, { maxTasks: 1 }) as any).error, /Too many/);
  assert.match((parseSubagentInvocation({ action: "join", runIds: [conversationId] }) as any).error, /conversation ID is not accepted/);
  assert.match((parseSubagentInvocation({ action: "remove", conversationIds: [runId] }) as any).error, /run ID is not accepted/);
  assert.ok("error" in parseSubagentInvocation({ action: "join", runIds: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "remove" }));
});

test("schema and parser reject extra and action-inappropriate fields", () => {
  for (const raw of [
    { action: "agents", status: ["running"] },
    { action: "list", tasks: [{ agent: "a", prompt: "x" }] },
    { action: "run", tasks: [{ agent: "a", prompt: "x", surprise: true }] },
    { action: "join", runIds: [runId], conversationIds: [conversationId] },
    { action: "remove", conversationIds: [conversationId], extra: true },
  ]) {
    assert.equal(Check(SubagentParams, raw), false);
    assert.ok("error" in parseSubagentInvocation(raw));
  }
  assert.equal(Check(TaskSchema, { agent: "a", prompt: "x", extra: true }), false);
  assert.equal(Check(TaskSchema, { conversationId, prompt: "x", label: "no" }), false);
});

test("removed session, retention, background, dispatch, wait, results, and remove forms give migrations", () => {
  for (const raw of [
    { action: "run", tasks: [], background: true },
    { action: "run", tasks: [], dispatch: "background" },
    { action: "join", runIds: [runId], wait: true },
    { action: "results", runIds: [runId] },
    { action: "join", runIds: [runId], results: true },
    { action: "join", runIds: [runId], remove: true },
    { action: "run", tasks: [{ sessionId: conversationId, prompt: "x" }] },
    { action: "run", tasks: [{ agent: "a", prompt: "x", retainConversation: true }] },
  ]) { const parsed = parseSubagentInvocation(raw); assert.ok("error" in parsed); assert.match(parsed.error, /removed|Use|retained/); }
});
