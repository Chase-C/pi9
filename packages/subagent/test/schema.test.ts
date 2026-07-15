import { test } from "vitest";
import assert from "node:assert/strict";
import { Check } from "typebox/value";

import { SubagentParams, TaskSchema, parseSubagentInvocation, parseTask } from "../src/schema.js";

test("TaskSchema accepts an optional label string and rejects non-string values", () => {
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", label: "researcher" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", label: 42 }), false);
});

test("TaskSchema accepts an optional resumable boolean and rejects non-boolean values", () => {
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", resumable: true }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", resumable: false }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", resumable: "true" }), false);
});

test("TaskSchema accepts an optional skills string array and rejects non-string-array values", () => {
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", skills: [], prompt: "do work" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", skills: ["tdd", "review"], prompt: "do work" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", skills: "tdd" }), false);
  assert.equal(Check(TaskSchema, { agent: "helper", skills: [42], prompt: "do work" }), false);
  assert.equal(Check(TaskSchema, { agent: "helper", skills: [""], prompt: "do work" }), false);
});

test("TaskSchema rejects empty strings and unsupported thinking levels", () => {
  assert.equal(Check(TaskSchema, { agent: "", prompt: "do work" }), false);
  assert.equal(Check(TaskSchema, { sessionId: "", prompt: "follow up" }), false);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "" }), false);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", model: "" }), false);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", cwd: "" }), false);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", thinking: "extreme" }), false);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", thinking: "xhigh" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", thinking: "max" }), true);
});

test("parseTask classifies spawn vs resume by which key is present and preserves all fields", () => {
  const spawn = parseTask({
    agent: "helper",
    prompt: "do work",
    label: "researcher",
    skills: ["tdd"],
    resumable: true,
    model: "m",
    thinking: "max",
    cwd: "sub",
  });
  assert.deepEqual(spawn, {
    kind: "spawn",
    agent: "helper",
    prompt: "do work",
    label: "researcher",
    skills: ["tdd"],
    resumable: true,
    model: "m",
    thinking: "max",
    cwd: "sub",
  });

  const resume = parseTask({
    sessionId: "sess-1",
    prompt: "follow up",
    label: "phase 2",
    resumable: false,
  });
  assert.deepEqual(resume, {
    kind: "resume",
    sessionId: "sess-1",
    prompt: "follow up",
    label: "phase 2",
    resumable: false,
  });
});

test("parseTask rejects a task that carries both agent and sessionId", () => {
  const result = parseTask({ agent: "helper", sessionId: "s", prompt: "p" });
  assert.ok("error" in result);
  assert.match(result.error, /both agent and sessionId/);
});

test("parseTask rejects a task that carries neither agent nor sessionId", () => {
  const result = parseTask({ prompt: "p" });
  assert.ok("error" in result);
  assert.match(result.error, /exactly one of agent .* or sessionId/);
});

test("parseTask rejects a resume task that carries spawn-only fields", () => {
  for (const field of ["model", "thinking", "cwd", "skills"] as const) {
    const value = field === "skills" ? ["tdd"] : "whatever";
    const result = parseTask({ sessionId: "s", prompt: "p", [field]: value });
    assert.ok("error" in result, `expected ${field} to be rejected`);
    assert.match(result.error, new RegExp(`rejects ${field}`));
  }
});

test("parseTask rejects an empty prompt and unstructured tasks", () => {
  const empty = parseTask({ agent: "helper", prompt: "   " });
  assert.ok("error" in empty);
  assert.match(empty.error, /non-empty/);

  const noObj = parseTask(null);
  assert.ok("error" in noObj);
  assert.match(noObj.error, /must be an object/);
});

test("parseTask rejects skills entries that are not non-empty strings", () => {
  const result = parseTask({ agent: "helper", skills: ["", "x"], prompt: "p" });
  assert.ok("error" in result);
  assert.match(result.error, /skills entries/);

  const notArray = parseTask({ agent: "helper", prompt: "p", skills: "tdd" });
  assert.ok("error" in notArray);
  assert.match(notArray.error, /skills must be an array/);
});

test("parseTask rejects unsupported thinking levels", () => {
  const result = parseTask({ agent: "helper", prompt: "p", thinking: "extreme" });
  assert.ok("error" in result);
  assert.match(result.error, /thinking must be one of/);
});

test("parseSubagentInvocation narrows every action arm without carrying extra fields", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "agents", tasks: "ignored" }), { action: "agents" });
  assert.deepEqual(
    parseSubagentInvocation({ action: "list", status: ["running"], extra: "ignored" }),
    { action: "list", status: ["running"] },
  );
  assert.deepEqual(
    parseSubagentInvocation({ action: "run", tasks: [{ agent: "helper", prompt: "do work" }], extra: "ignored" }),
    { action: "run", tasks: [{ kind: "spawn", agent: "helper", prompt: "do work" }] },
  );
  assert.deepEqual(
    parseSubagentInvocation({ action: "results", sessionIds: ["s1"], remove: true, extra: "ignored" }),
    { action: "results", sessionIds: ["s1"], remove: true },
  );
  assert.deepEqual(
    parseSubagentInvocation({ action: "remove", scope: "retained", extra: "ignored" }),
    { action: "remove", scope: "retained" },
  );
});

test("parseSubagentInvocation applies the configured run task limit before task parsing", () => {
  const result = parseSubagentInvocation(
    { action: "run", tasks: [{ agent: "helper", prompt: "one" }, { agent: "helper", prompt: "two" }] },
    { maxTasks: 1 },
  );
  assert.deepEqual(result, {
    error: "Too many tasks (2). Max is 1.",
    action: "run",
    taskCountError: true,
  });
});

test("parseSubagentInvocation validates action presence and values", () => {
  const missing = parseSubagentInvocation({});
  assert.ok("error" in missing);
  assert.equal(missing.missingAction, true);

  const unknown = parseSubagentInvocation({ action: "resume" });
  assert.ok("error" in unknown);
  assert.match(unknown.error, /Unknown action/);
});

test("parseSubagentInvocation centralizes action field validation", () => {
  const list = parseSubagentInvocation({ action: "list", status: ["stale"] });
  assert.ok("error" in list);
  assert.match(list.error, /Unknown status 'stale'/);

  const results = parseSubagentInvocation({ action: "results", sessionIds: [""] });
  assert.ok("error" in results);
  assert.match(results.error, /non-empty strings/);

  const remove = parseSubagentInvocation({ action: "remove", sessionIds: ["s1"], scope: "retained" });
  assert.ok("error" in remove);
  assert.match(remove.error, /exactly one of sessionIds or scope/);
});

test("parseSubagentInvocation requires current boolean fields", () => {
  assert.deepEqual(
    parseSubagentInvocation({ action: "run", tasks: [{ agent: "helper", prompt: "work" }], background: "false" }),
    { error: "run background must be a boolean.", action: "run" },
  );
  assert.deepEqual(
    parseSubagentInvocation({ action: "results", sessionIds: ["s1"], remove: "false" }),
    { error: "results remove must be a boolean.", action: "results" },
  );
});

test("SubagentParams accepts results action with sessionIds and optional remove flag", () => {
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: ["s1"] }), true);
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: ["s1", "s2"], remove: true }), true);
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: ["s1"], remove: false }), true);
});

test("SubagentParams rejects empty task and session ID arrays", () => {
  assert.equal(Check(SubagentParams, { action: "run", tasks: [] }), false);
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: [] }), false);
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: [""] }), false);
});

test("SubagentParams rejects results action when remove is not a boolean", () => {
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: ["s1"], remove: "yes" }), false);
});

test("schema distinguishes result retention from conversation resumability", () => {
  assert.equal(
    (TaskSchema.properties.resumable as any).description,
    "Override conversation follow-ups. true retains context; false releases it after this attempt (foreground sessions then leave inventory).",
  );
  assert.equal(
    (SubagentParams.properties.background as any).description,
    "For run. false (default) waits for all tasks and returns results; true returns handles immediately. Background results remain retrievable until removed, regardless of resumable.",
  );
});

test("schema defines every remove scope", () => {
  assert.equal(
    (SubagentParams.properties.scope as any).description,
    "For remove. background=all background sessions; retained=non-running resumable foreground sessions; non-running=all queued or terminal sessions. Mutually exclusive with sessionIds.",
  );
});

test("SubagentParams constrains action, status, and scope values", () => {
  assert.equal(Check(SubagentParams, { action: "bogus" }), false);
  assert.equal(Check(SubagentParams, { action: "list", status: ["running", "completed"] }), true);
  assert.equal(Check(SubagentParams, { action: "list", status: ["stale"] }), false);
  assert.equal(Check(SubagentParams, { action: "remove", scope: "background" }), true);
  assert.equal(Check(SubagentParams, { action: "remove", scope: "everything" }), false);
});

