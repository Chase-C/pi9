import { test } from "vitest";
import assert from "node:assert/strict";
import { Check } from "typebox/value";

import { SubagentParams, TaskSchema, parseTask } from "../src/schema.js";

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
});

test("parseTask classifies spawn vs resume by which key is present and preserves all fields", () => {
  const spawn = parseTask({
    agent: "helper",
    prompt: "do work",
    label: "researcher",
    skills: ["tdd"],
    resumable: true,
    model: "m",
    thinking: "high",
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
    thinking: "high",
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

test("parseTask rejects a task carrying the batch-level background field", () => {
  const spawn = parseTask({ agent: "helper", prompt: "do work", background: true });
  assert.ok("error" in spawn);
  assert.match(spawn.error, /background is a batch-level flag on action='run', not a per-task field\./);

  const resume = parseTask({ sessionId: "s", prompt: "follow up", background: true });
  assert.ok("error" in resume);
  assert.match(resume.error, /background is a batch-level flag on action='run', not a per-task field\./);
});

test("SubagentParams accepts results action with sessionIds and optional remove flag", () => {
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: ["s1"] }), true);
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: ["s1", "s2"], remove: true }), true);
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: ["s1"], remove: false }), true);
});

test("SubagentParams rejects empty sessionId strings", () => {
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: [""] }), false);
});

test("SubagentParams rejects results action when remove is not a boolean", () => {
  assert.equal(Check(SubagentParams, { action: "results", sessionIds: ["s1"], remove: "yes" }), false);
});

test("SubagentParams constrains action, status, and scope values", () => {
  assert.equal(Check(SubagentParams, { action: "bogus" }), false);
  assert.equal(Check(SubagentParams, { action: "list", status: ["running", "completed"] }), true);
  assert.equal(Check(SubagentParams, { action: "list", status: ["stale"] }), false);
  assert.equal(Check(SubagentParams, { action: "remove", scope: "background" }), true);
  assert.equal(Check(SubagentParams, { action: "remove", scope: "everything" }), false);
});

