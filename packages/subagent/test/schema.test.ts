import { test } from "vitest";
import assert from "node:assert/strict";
import { Check } from "typebox/value";

import { SubagentParams, TaskSchema, parseSubagentInvocation, parseTask } from "../src/schema.js";

test("TaskSchema keeps label optional for the flat provider schema and rejects non-string values", () => {
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
  assert.equal(Check(TaskSchema, { agent: "helper", skills: [""], prompt: "do work" }), true);
});

test("TaskSchema leaves blank-string validation to runtime and constrains thinking levels", () => {
  assert.equal(Check(TaskSchema, { agent: "", prompt: "do work" }), true);
  assert.equal(Check(TaskSchema, { sessionId: "", prompt: "follow up" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", model: "" }), true);
  assert.equal(Check(TaskSchema, { agent: "helper", prompt: "do work", cwd: "" }), true);
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
  const result = parseTask({ agent: "helper", sessionId: "s", prompt: "p", label: "work" });
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

test("parseTask rejects blank identifiers and prompts", () => {
  for (const task of [
    { agent: "   ", prompt: "work", label: "work" },
    { sessionId: "   ", prompt: "follow up" },
    { agent: "helper", prompt: "   ", label: "work" },
  ]) {
    const result = parseTask(task);
    assert.ok("error" in result);
    assert.match(result.error, /non-empty/);
  }

  const noObj = parseTask(null);
  assert.ok("error" in noObj);
  assert.match(noObj.error, /must be an object/);
});

test("parseTask requires a non-empty label for spawns and accepts an omitted resume label", () => {
  for (const label of [undefined, "", "   "]) {
    const result = parseTask({ agent: "helper", prompt: "p", ...(label !== undefined ? { label } : {}) });
    assert.ok("error" in result);
    assert.match(result.error, /Spawn task label|Task label/);
  }

  assert.deepEqual(parseTask({ sessionId: "s", prompt: "follow up" }), {
    kind: "resume",
    sessionId: "s",
    prompt: "follow up",
  });
});

test("parseTask rejects blank spawn-only string overrides", () => {
  for (const field of ["model", "cwd"] as const) {
    const result = parseTask({ agent: "helper", prompt: "p", label: "work", [field]: "   " });
    assert.ok("error" in result);
    assert.match(result.error, new RegExp(`${field} must be a non-empty string`));
  }
});

test("parseTask rejects skills entries that are not non-empty strings", () => {
  const result = parseTask({ agent: "helper", skills: ["", "x"], prompt: "p", label: "work" });
  assert.ok("error" in result);
  assert.match(result.error, /skills entries/);

  const notArray = parseTask({ agent: "helper", prompt: "p", label: "work", skills: "tdd" });
  assert.ok("error" in notArray);
  assert.match(notArray.error, /skills must be an array/);
});

test("parseTask rejects unsupported thinking levels", () => {
  const result = parseTask({ agent: "helper", prompt: "p", label: "work", thinking: "extreme" });
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
    parseSubagentInvocation({ action: "run", tasks: [{ agent: "helper", prompt: "do work", label: "work" }], extra: "ignored" }),
    { action: "run", tasks: [{ kind: "spawn", agent: "helper", prompt: "do work", label: "work" }] },
  );
  assert.deepEqual(
    parseSubagentInvocation({ action: "results", sessionIds: ["s1"], remove: true, extra: "ignored" }),
    { action: "results", sessionIds: ["s1"], remove: true },
  );
  assert.deepEqual(
    parseSubagentInvocation({ action: "remove", sessionIds: ["s1"], extra: "ignored" }),
    { action: "remove", sessionIds: ["s1"] },
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

  const removeMissing = parseSubagentInvocation({ action: "remove" });
  assert.ok("error" in removeMissing);
  assert.match(removeMissing.error, /requires sessionIds/);

  const removeBlank = parseSubagentInvocation({ action: "remove", sessionIds: ["   "] });
  assert.ok("error" in removeBlank);
  assert.match(removeBlank.error, /non-empty strings/);
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

test("SubagentParams rejects empty arrays but leaves blank session IDs to runtime", () => {
  assert.equal(Check(SubagentParams, { action: "run", tasks: [] }), false);
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: [] }), false);
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: [""] }), true);
});

test("SubagentParams rejects results action when remove is not a boolean", () => {
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: ["s1"], remove: "yes" }), false);
});

test("schema describes labels, inventory filters, and result cleanup", () => {
  assert.equal(
    (TaskSchema.properties.label as any).description,
    "Display label for distinguishing tasks; required for new session.",
  );
  assert.equal(
    (SubagentParams.properties.status as any).description,
    "list only: statuses to include.",
  );
  assert.equal(
    (SubagentParams.properties.remove as any).description,
    "results only: remove terminal sessions once returned; pending sessions remain.",
  );
});

test("schema concisely distinguishes foreground waiting, background retrieval, and resumability", () => {
  assert.equal(
    (TaskSchema.properties.resumable as any).description,
    "true keeps child context for follow-ups; false releases it after this attempt.",
  );
  assert.equal(
    (SubagentParams.properties.background as any).description,
    "run only: true returns handles immediately; false (default) waits for results. Background results remain available until removed.",
  );
});

test("schema exposes explicit-ID removal without a scope field", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(SubagentParams.properties, "scope"), false);
  assert.equal(Check(SubagentParams, { action: "remove", sessionIds: ["s1"] }), true);
});

test("SubagentParams constrains action and status values", () => {
  assert.equal(Check(SubagentParams, { action: "bogus" }), false);
  assert.equal(Check(SubagentParams, { action: "list", status: ["running", "completed"] }), true);
  assert.equal(Check(SubagentParams, { action: "list", status: ["stale"] }), false);
});

