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
} from "../src/schema.js";

const conversationId = "amber-acorn";
const runId = "adapt-ably";

test("public schema exposes separate run and steer inputs without unions", () => {
  assert.deepEqual(SUBAGENT_ACTIONS, ["agents", "list", "run", "steer", "inspect", "join", "remove"]);
  assert.doesNotMatch(JSON.stringify(SubagentParams), /"anyOf"/);
  assert.equal(Check(SubagentParams, { action: "run", spawns: [{ agent: "helper", prompt: "work" }] }), true);
  assert.equal(Check(SubagentParams, { action: "run", resumes: [{ conversationId, prompt: "continue" }] }), true);
  assert.equal(Check(SubagentParams, { action: "steer", messages: [{ runId, message: "redirect" }] }), true);
  assert.equal(Check(SubagentParams, { action: "run", spawns: [] }), false);
  assert.equal(Check(SubagentParams, { action: "steer", messages: [{ runId, prompt: "old field" }] }), false);
  assert.equal(Check(SpawnTaskSchema, { conversationId, prompt: "wrong kind" }), false);
  assert.equal(Check(ResumeTaskSchema, { conversationId, prompt: "continue" }), true);
  assert.equal(Check(SteerMessageSchema, { runId, message: "redirect" }), true);
});

test("spawn fields are validated and preserved", () => {
  assert.deepEqual(
    parseSpawnTask({ agent: "helper", prompt: "work", label: "label", skills: ["review"], model: "m", thinking: "high", cwd: "sub" }),
    { kind: "spawn", agent: "helper", prompt: "work", label: "label", skills: ["review"], model: "m", thinking: "high", cwd: "sub" },
  );
  for (const task of [null, { prompt: "x" }, { agent: "", prompt: "x" }, { agent: "a", prompt: " " }, { agent: "a", prompt: "x", skills: [""] }, { agent: "a", prompt: "x", thinking: "extreme" }]) {
    assert.ok("error" in parseSpawnTask(task));
  }
});

test("resume task accepts conversationId and prompt only", () => {
  assert.deepEqual(parseResumeTask({ conversationId, prompt: "next" }), { kind: "resume", conversationId, prompt: "next" });
  const wrongKind = parseResumeTask({ conversationId: runId, prompt: "next" });
  assert.ok("error" in wrongKind);
  assert.match(wrongKind.error, /run ID is not accepted/);
  const extra = parseResumeTask({ conversationId, prompt: "next", model: "x" });
  assert.ok("error" in extra);
  assert.match(extra.error, /model is not allowed/);
});

test("steer message accepts runId and message only", () => {
  assert.deepEqual(parseSteerMessage({ runId, message: "change direction" }), { kind: "steer", runId, message: "change direction" });
  const wrongKind = parseSteerMessage({ runId: conversationId, message: "change direction" });
  assert.ok("error" in wrongKind);
  assert.match(wrongKind.error, /conversation ID is not accepted/);
  const oldField = parseSteerMessage({ runId, prompt: "change direction" });
  assert.ok("error" in oldField);
  assert.match(oldField.error, /prompt is not allowed/);
});

test("invocations parse every action without dispatch alias", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "agents" }), { action: "agents" });
  assert.deepEqual(parseSubagentInvocation({ action: "list", status: ["running"] }), { action: "list", status: ["running"] });
  assert.deepEqual(parseSubagentInvocation({
    action: "run",
    spawns: [{ agent: "helper", prompt: "x" }],
    resumes: [{ conversationId, prompt: "next" }],
  }), {
    action: "run",
    spawns: [{ kind: "spawn", agent: "helper", prompt: "x" }],
    resumes: [{ kind: "resume", conversationId, prompt: "next" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "steer", messages: [{ runId, message: "redirect" }] }), {
    action: "steer",
    messages: [{ kind: "steer", runId, message: "redirect" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "inspect", runIds: [runId] }), { action: "inspect", runIds: [runId] });
  assert.deepEqual(parseSubagentInvocation({ action: "join", runIds: [runId] }), { action: "join", runIds: [runId] });
  assert.deepEqual(parseSubagentInvocation({ action: "remove", conversationIds: [conversationId] }), { action: "remove", conversationIds: [conversationId] });
  assert.ok("error" in parseSubagentInvocation({ action: "dispatch", tasks: [] }));
});

test("run allows either or both task arrays and applies a combined limit", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "run", spawns: [{ agent: "helper", prompt: "x" }] }), {
    action: "run",
    spawns: [{ kind: "spawn", agent: "helper", prompt: "x" }],
    resumes: [],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "run", resumes: [{ conversationId, prompt: "x" }] }), {
    action: "run",
    spawns: [],
    resumes: [{ kind: "resume", conversationId, prompt: "x" }],
  });
  assert.ok("error" in parseSubagentInvocation({ action: "run" }));
  assert.ok("error" in parseSubagentInvocation({ action: "run", spawns: [], resumes: [{ conversationId, prompt: "x" }] }));
  assert.ok("error" in parseSubagentInvocation({ action: "run", spawns: {}, resumes: [{ conversationId, prompt: "x" }] }));
  assert.match((parseSubagentInvocation({
    action: "run",
    spawns: [{ agent: "a", prompt: "1" }],
    resumes: [{ conversationId, prompt: "2" }],
  }, { maxTasks: 1 }) as { error: string }).error, /Too many/);
});

test("steer validates its own batch and limit", () => {
  assert.ok("error" in parseSubagentInvocation({ action: "steer" }));
  assert.ok("error" in parseSubagentInvocation({ action: "steer", messages: [] }));
  assert.match((parseSubagentInvocation({
    action: "steer",
    messages: [{ runId, message: "1" }, { runId, message: "2" }],
  }, { maxTasks: 1 }) as { error: string }).error, /Too many/);
});

test("item parse failures remain indexed within their typed arrays", () => {
  assert.deepEqual(parseSubagentInvocation({
    action: "run",
    spawns: [{ agent: "helper", prompt: "first" }, { prompt: "missing agent", label: "invalid spawn" }],
    resumes: [{ conversationId, prompt: "third" }],
  }), {
    action: "run",
    spawns: [
      { kind: "spawn", agent: "helper", prompt: "first" },
      { error: "Spawn task agent must be a non-empty string.", label: "invalid spawn" },
    ],
    resumes: [{ kind: "resume", conversationId, prompt: "third" }],
  });
});

test("inspect retains malformed targets as ordered per-run errors", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "inspect", runIds: [runId, conversationId, "not-an-id"] }), {
    action: "inspect",
    runIds: [
      runId,
      { runId: conversationId, error: `inspect received invalid runId '${conversationId}' (a conversation ID is not accepted).` },
      { runId: "not-an-id", error: "inspect received invalid runId format 'not-an-id'." },
    ],
  });
});

test("whole invocation validation covers unchanged actions", () => {
  assert.ok("error" in parseSubagentInvocation({}));
  assert.ok("error" in parseSubagentInvocation({ action: "unknown" }));
  assert.ok("error" in parseSubagentInvocation({ action: "list", status: ["stale"] }));
  assert.ok("error" in parseSubagentInvocation({ action: "inspect", runIds: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "join", runIds: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "remove" }));
});

test("unsupported invocation fields receive ordinary validation errors", () => {
  for (const [raw, expected] of [
    [{ action: "run", spawns: [{ agent: "a", prompt: "x" }], background: true }, /Property background is not allowed/],
    [{ action: "steer", messages: [{ runId, message: "x" }], prompt: "x" }, /Property prompt is not allowed/],
    [{ action: "inspect", runIds: [runId], wait: true }, /Property wait is not allowed/],
    [{ action: "results", runIds: [runId] }, /Unknown action/],
    [{ action: "join", runIds: [runId], remove: true }, /Property remove is not allowed/],
  ] as const) {
    const parsed = parseSubagentInvocation(raw);
    assert.ok("error" in parsed);
    assert.match(parsed.error, expected);
  }
});

test("flat schema admits action fields while parser enforces associations", () => {
  for (const raw of [
    { action: "agents", status: ["running"] },
    { action: "list", spawns: [{ agent: "a", prompt: "x" }] },
    { action: "join", runIds: [runId], conversationIds: [conversationId] },
  ]) {
    assert.equal(Check(SubagentParams, raw), true);
    assert.ok("error" in parseSubagentInvocation(raw));
  }
});

test("schema and parser reject unknown properties", () => {
  const invocation = { action: "remove", conversationIds: [conversationId], extra: true };
  assert.equal(Check(SubagentParams, invocation), false);
  assert.ok("error" in parseSubagentInvocation(invocation));
  assert.equal(Check(SpawnTaskSchema, { agent: "a", prompt: "x", extra: true }), false);
  assert.ok("error" in parseSpawnTask({ agent: "a", prompt: "x", extra: true }));
});

test("join and remove ID diagnostics distinguish ID kinds and malformed IDs", () => {
  const wrongJoin = parseSubagentInvocation({ action: "join", runIds: [conversationId] });
  assert.ok("error" in wrongJoin);
  assert.match(wrongJoin.error, /conversation ID is not accepted/);
  const malformedJoin = parseSubagentInvocation({ action: "join", runIds: ["not-an-id"] });
  assert.ok("error" in malformedJoin);
  assert.match(malformedJoin.error, /invalid runId format/);

  const wrongRemove = parseSubagentInvocation({ action: "remove", conversationIds: [runId] });
  assert.ok("error" in wrongRemove);
  assert.match(wrongRemove.error, /run ID is not accepted/);
  const malformedRemove = parseSubagentInvocation({ action: "remove", conversationIds: ["not-an-id"] });
  assert.ok("error" in malformedRemove);
  assert.match(malformedRemove.error, /invalid conversationId format/);
});
