import { test } from "vitest";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import {
  parseResumeTask,
  parseSpawnTask,
  parseSteerMessage,
  parseSubagentInvocation,
  ResumeTaskSchema,
  SpawnTaskSchema,
  SteerMessageSchema,
  SubagentParams,
  SUBAGENT_ACTIONS,
  SUBAGENT_STATUSES,
} from "../src/schema.js";

const subagentId = "amber-acorn";
const runId = "adapt-ably";

test("public schema exposes the redesigned contract", () => {
  assert.deepEqual(SUBAGENT_ACTIONS, ["agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", "remove"]);
  assert.deepEqual(SUBAGENT_STATUSES, ["queued", "running", "completed", "failed", "cancelled"]);
  assert.doesNotMatch(JSON.stringify(SubagentParams), /"anyOf"/);
  assert.equal(Check(SubagentParams, { action: "list", statuses: ["running", "failed"], joined: false }), true);
  assert.equal(Check(SubagentParams, { action: "spawn", spawns: [{ agent: "helper", prompt: "work", label: "task" }] }), true);
  assert.equal(Check(SubagentParams, { action: "spawn", spawns: [{ agent: "helper", prompt: "work" }] }), false);
  assert.equal(Check(SubagentParams, { action: "resume", resumes: [{ subagentId, prompt: "continue" }] }), true);
  assert.equal(Check(SubagentParams, { action: "steer", messages: [{ subagentId, message: "redirect" }] }), true);
  for (const action of ["cancel", "inspect", "join", "remove"] as const) {
    assert.equal(Check(SubagentParams, { action, subagentIds: [subagentId] }), true);
  }
  assert.equal(Check(SubagentParams, { action: "cancel", runIds: [runId] }), false);
  assert.equal(Check(ResumeTaskSchema, { subagentId, prompt: "continue" }), true);
  assert.equal(Check(SteerMessageSchema, { subagentId, message: "redirect" }), true);
});

test("list accepts public status and joined filters", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "list" }), { action: "list" });
  assert.deepEqual(parseSubagentInvocation({ action: "list", statuses: ["queued", "failed"], joined: false }), {
    action: "list",
    statuses: ["queued", "failed"],
    joined: false,
  });
  for (const raw of [
    { action: "list", statuses: [] },
    { action: "list", statuses: ["error"] },
    { action: "list", joined: "false" },
    { action: "list", state: ["active"] },
    { action: "list", scope: "descendants" },
  ]) assert.ok("error" in parseSubagentInvocation(raw));
});

test("spawn requires and preserves a nonblank label", () => {
  assert.deepEqual(
    parseSpawnTask({ agent: "helper", prompt: "work", label: "review", skills: ["review"], model: "m", thinking: "high", cwd: "sub" }),
    { kind: "spawn", agent: "helper", prompt: "work", label: "review", skills: ["review"], model: "m", thinking: "high", cwd: "sub" },
  );
  for (const task of [
    null,
    { agent: "helper", prompt: "work" },
    { agent: "helper", prompt: "work", label: " " },
    { agent: "", prompt: "x", label: "task" },
    { agent: "a", prompt: " ", label: "task" },
    { agent: "a", prompt: "x", label: "task", skills: [""] },
    { agent: "a", prompt: "x", label: "task", thinking: "extreme" },
  ]) assert.ok("error" in parseSpawnTask(task));
});

test("duplicate spawn labels remain valid", () => {
  const parsed = parseSubagentInvocation({
    action: "spawn",
    spawns: [
      { agent: "helper", prompt: "one", label: "same" },
      { agent: "helper", prompt: "two", label: "same" },
    ],
  });
  assert.ok(!("error" in parsed));
});

test("resume and steer accept only stable subagent IDs", () => {
  assert.deepEqual(parseResumeTask({ subagentId, prompt: "next" }), { kind: "resume", subagentId, prompt: "next" });
  assert.deepEqual(parseSteerMessage({ subagentId, message: "change direction" }), { kind: "steer", subagentId, message: "change direction" });
  assert.ok("error" in parseResumeTask({ subagentId: runId, prompt: "next" }));
  assert.ok("error" in parseSteerMessage({ subagentId: runId, message: "next" }));
  assert.match((parseResumeTask({ subagentId, prompt: "next", model: "x" }) as { error: string }).error, /model is not allowed/);
  assert.match((parseSteerMessage({ subagentId, prompt: "next" }) as { error: string }).error, /prompt is not allowed/);
});

test("invocations parse every action", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "agents" }), { action: "agents" });
  assert.deepEqual(parseSubagentInvocation({ action: "spawn", spawns: [{ agent: "helper", prompt: "x", label: "task" }] }), {
    action: "spawn", spawns: [{ kind: "spawn", agent: "helper", prompt: "x", label: "task" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "resume", resumes: [{ subagentId, prompt: "next" }] }), {
    action: "resume", resumes: [{ kind: "resume", subagentId, prompt: "next" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "steer", messages: [{ subagentId, message: "redirect" }] }), {
    action: "steer", messages: [{ kind: "steer", subagentId, message: "redirect" }],
  });
  for (const action of ["cancel", "inspect", "join", "remove"] as const) {
    assert.deepEqual(parseSubagentInvocation({ action, subagentIds: [subagentId] }), { action, subagentIds: [subagentId] });
  }
  assert.ok("error" in parseSubagentInvocation({ action: "run", spawns: [] }));
});

test("batch actions validate counts and preserve ordered item failures", () => {
  for (const raw of [
    { action: "spawn" }, { action: "spawn", spawns: [] },
    { action: "resume" }, { action: "resume", resumes: [] },
    { action: "steer" }, { action: "steer", messages: [] },
  ]) assert.ok("error" in parseSubagentInvocation(raw));
  assert.match((parseSubagentInvocation({
    action: "spawn",
    spawns: [{ agent: "a", prompt: "1", label: "one" }, { agent: "a", prompt: "2", label: "two" }],
  }, { maxTasks: 1 }) as { error: string }).error, /Too many/);
  assert.deepEqual(parseSubagentInvocation({
    action: "spawn",
    spawns: [{ agent: "helper", prompt: "first", label: "valid" }, { prompt: "missing agent", label: "invalid" }],
  }), {
    action: "spawn",
    spawns: [
      { kind: "spawn", agent: "helper", prompt: "first", label: "valid" },
      { error: "Spawn task agent must be a non-empty string.", label: "invalid" },
    ],
  });
});

test("target actions preserve invalid and duplicate targets as ordered failures", () => {
  for (const action of ["cancel", "inspect", "join", "remove"] as const) {
    assert.deepEqual(parseSubagentInvocation({ action, subagentIds: [subagentId, runId, subagentId] }), {
      action,
      subagentIds: [
        subagentId,
        { subagentId: runId, error: `Invalid subagentId format: ${runId}.` },
        { subagentId, error: `Duplicate subagentId ${subagentId} in this request; the first occurrence was processed.` },
      ],
    });
  }
});

test("resume and steer preserve duplicate targets as ordered failures", () => {
  assert.deepEqual(parseSubagentInvocation({
    action: "resume",
    resumes: [
      { subagentId, prompt: "first" },
      { subagentId, prompt: "second" },
    ],
  }), {
    action: "resume",
    resumes: [
      { kind: "resume", subagentId, prompt: "first" },
      { subagentId, error: `Duplicate subagentId ${subagentId} in this request; the first occurrence was processed.` },
    ],
  });
  assert.deepEqual(parseSubagentInvocation({
    action: "steer",
    messages: [
      { subagentId, message: "first" },
      { subagentId, message: "second" },
    ],
  }), {
    action: "steer",
    messages: [
      { kind: "steer", subagentId, message: "first" },
      { subagentId, error: `Duplicate subagentId ${subagentId} in this request; the first occurrence was processed.` },
    ],
  });
});

test("parser enforces action-specific properties", () => {
  for (const raw of [
    {},
    { action: "unknown" },
    { action: "agents", statuses: ["running"] },
    { action: "list", spawns: [{ agent: "a", prompt: "x", label: "task" }] },
    { action: "spawn", spawns: [{ agent: "a", prompt: "x", label: "task" }], background: true },
    { action: "resume", resumes: [{ subagentId, prompt: "x" }], model: "x" },
    { action: "cancel", subagentIds: [subagentId], force: true },
    { action: "join", subagentIds: [subagentId], remove: true },
  ]) assert.ok("error" in parseSubagentInvocation(raw));
});

test("schema and parser reject unknown properties", () => {
  const invocation = { action: "remove", subagentIds: [subagentId], extra: true };
  assert.equal(Check(SubagentParams, invocation), false);
  assert.ok("error" in parseSubagentInvocation(invocation));
  assert.equal(Check(SpawnTaskSchema, { agent: "a", prompt: "x", label: "task", extra: true }), false);
  assert.ok("error" in parseSpawnTask({ agent: "a", prompt: "x", label: "task", extra: true }));
});
