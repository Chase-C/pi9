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

test("public schema targets stable subagent IDs", () => {
  assert.deepEqual(SUBAGENT_ACTIONS, ["agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", "remove"]);
  assert.doesNotMatch(JSON.stringify(SubagentParams), /"anyOf"/);
  assert.equal(Check(SubagentParams, { action: "list", scope: "descendants", state: ["active"] }), true);
  assert.equal(Check(SubagentParams, { action: "spawn", spawns: [{ agent: "helper", prompt: "work" }] }), true);
  assert.equal(Check(SubagentParams, { action: "resume", resumes: [{ subagentId: conversationId, prompt: "continue" }] }), true);
  assert.equal(Check(SubagentParams, { action: "steer", messages: [{ subagentId: conversationId, message: "redirect" }] }), true);
  assert.equal(Check(SubagentParams, { action: "cancel", subagentIds: [conversationId] }), true);
  assert.equal(Check(SubagentParams, { action: "inspect", subagentIds: [conversationId] }), true);
  assert.equal(Check(SubagentParams, { action: "join", subagentIds: [conversationId] }), true);
  assert.equal(Check(SubagentParams, { action: "remove", subagentIds: [conversationId] }), true);
  assert.equal(Check(SubagentParams, { action: "cancel", runIds: [runId] }), false);
  assert.equal(Check(ResumeTaskSchema, { subagentId: conversationId, prompt: "continue" }), true);
  assert.equal(Check(SteerMessageSchema, { subagentId: conversationId, message: "redirect" }), true);
});

test("list accepts awaiting_join lifecycle state", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "list", state: ["awaiting_join"] }), {
    action: "list",
    scope: "children",
    state: ["awaiting_join"],
  });
});

test("list defaults to children and accepts descendants scope", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "list" }), { action: "list", scope: "children" });
  assert.deepEqual(parseSubagentInvocation({ action: "list", scope: "descendants" }), { action: "list", scope: "descendants" });
  assert.deepEqual(parseSubagentInvocation({ action: "list", scope: "global" }), {
    action: "list",
    error: "list scope must be children or descendants.",
  });
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

test("resume task accepts subagentId and prompt only", () => {
  assert.deepEqual(parseResumeTask({ subagentId: conversationId, prompt: "next" }), { kind: "resume", subagentId: conversationId, prompt: "next" });
  assert.deepEqual(parseResumeTask({ subagentId: runId, prompt: "next" }), {
    subagentId: runId,
    error: "Unknown or invalid subagent ID.",
  });
  assert.deepEqual(parseResumeTask({ subagentId: "unknown-identifier", prompt: "next" }), {
    subagentId: "unknown-identifier",
    error: "Unknown or invalid subagent ID.",
  });
  const extra = parseResumeTask({ subagentId: conversationId, prompt: "next", model: "x" });
  assert.ok("error" in extra);
  assert.match(extra.error, /model is not allowed/);
});

test("steer message accepts subagentId and message only", () => {
  assert.deepEqual(parseSteerMessage({ subagentId: conversationId, message: "change direction" }), { kind: "steer", subagentId: conversationId, message: "change direction" });
  assert.deepEqual(parseSteerMessage({ subagentId: runId, message: "change direction" }), {
    subagentId: runId,
    error: "Unknown or invalid subagent ID.",
  });
  const oldField = parseSteerMessage({ subagentId: conversationId, prompt: "change direction" });
  assert.ok("error" in oldField);
  assert.match(oldField.error, /prompt is not allowed/);
});

test("invocations parse every action", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "agents" }), { action: "agents" });
  assert.deepEqual(parseSubagentInvocation({ action: "list", state: ["active", "resumable"] }), { action: "list", scope: "children", state: ["active", "resumable"] });
  assert.deepEqual(parseSubagentInvocation({ action: "spawn", spawns: [{ agent: "helper", prompt: "x" }] }), {
    action: "spawn", spawns: [{ kind: "spawn", agent: "helper", prompt: "x" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "resume", resumes: [{ subagentId: conversationId, prompt: "next" }] }), {
    action: "resume", resumes: [{ kind: "resume", subagentId: conversationId, prompt: "next" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "steer", messages: [{ subagentId: conversationId, message: "redirect" }] }), {
    action: "steer", messages: [{ kind: "steer", subagentId: conversationId, message: "redirect" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "cancel", subagentIds: [conversationId] }), { action: "cancel", subagentIds: [conversationId] });
  assert.deepEqual(parseSubagentInvocation({ action: "inspect", subagentIds: [conversationId] }), { action: "inspect", subagentIds: [conversationId] });
  assert.deepEqual(parseSubagentInvocation({ action: "join", subagentIds: [conversationId] }), { action: "join", subagentIds: [conversationId] });
  assert.deepEqual(parseSubagentInvocation({ action: "remove", subagentIds: [conversationId] }), { action: "remove", subagentIds: [conversationId] });
  assert.ok("error" in parseSubagentInvocation({ action: "run", spawns: [] }));
});

test("spawn and resume validate their own arrays and limits", () => {
  assert.ok("error" in parseSubagentInvocation({ action: "spawn" }));
  assert.ok("error" in parseSubagentInvocation({ action: "spawn", spawns: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "resume" }));
  assert.ok("error" in parseSubagentInvocation({ action: "resume", resumes: [] }));
  assert.match((parseSubagentInvocation({
    action: "spawn", spawns: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }],
  }, { maxTasks: 1 }) as { error: string }).error, /Too many/);
});

test("steer validates its own batch and limit", () => {
  assert.ok("error" in parseSubagentInvocation({ action: "steer" }));
  assert.ok("error" in parseSubagentInvocation({ action: "steer", messages: [] }));
  assert.match((parseSubagentInvocation({
    action: "steer", messages: [{ subagentId: conversationId, message: "1" }, { runId, message: "2" }],
  }, { maxTasks: 1 }) as { error: string }).error, /Too many/);
});

test("item parse failures remain ordered within each typed array", () => {
  assert.deepEqual(parseSubagentInvocation({
    action: "spawn",
    spawns: [{ agent: "helper", prompt: "first" }, { prompt: "missing agent", label: "invalid spawn" }],
  }), {
    action: "spawn",
    spawns: [
      { kind: "spawn", agent: "helper", prompt: "first" },
      { error: "Spawn task agent must be a non-empty string.", label: "invalid spawn" },
    ],
  });
});

test("target actions parse stable subagent IDs", () => {
  for (const action of ["cancel", "inspect", "join", "remove"] as const) {
    assert.deepEqual(parseSubagentInvocation({ action, subagentIds: [conversationId, runId, "not-an-id"] }), {
      action,
      subagentIds: [
        conversationId,
        { subagentId: runId, error: "Unknown or invalid subagent ID." },
        { subagentId: "not-an-id", error: "Unknown or invalid subagent ID." },
      ],
    });
  }
});

test("target actions reject every subagent ID occurrence after the first", () => {
  for (const action of ["cancel", "inspect", "join", "remove"] as const) {
    assert.deepEqual(parseSubagentInvocation({ action, subagentIds: [conversationId, conversationId] }), {
      action,
      subagentIds: [
        conversationId,
        { subagentId: conversationId, error: `Duplicate subagentId ${conversationId} in this request; the first occurrence was processed.` },
      ],
    });
  }
});

test("whole invocation validation covers every action", () => {
  assert.ok("error" in parseSubagentInvocation({}));
  assert.ok("error" in parseSubagentInvocation({ action: "unknown" }));
  assert.ok("error" in parseSubagentInvocation({ action: "list", state: ["stale"] }));
  assert.ok("error" in parseSubagentInvocation({ action: "list", state: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "list", status: ["running"] }));
  assert.ok("error" in parseSubagentInvocation({ action: "cancel", subagentIds: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "inspect", subagentIds: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "join", subagentIds: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "remove" }));
});

test("unsupported invocation fields receive ordinary validation errors", () => {
  for (const [raw, expected] of [
    [{ action: "spawn", spawns: [{ agent: "a", prompt: "x" }], background: true }, /Property background is not allowed/],
    [{ action: "resume", resumes: [{ subagentId: conversationId, prompt: "x" }], model: "x" }, /Property model is not allowed/],
    [{ action: "steer", messages: [{ subagentId: conversationId, message: "x" }], prompt: "x" }, /Property prompt is not allowed/],
    [{ action: "cancel", subagentIds: [conversationId], force: true }, /Property force is not allowed/],
    [{ action: "inspect", subagentIds: [conversationId], wait: true }, /Property wait is not allowed/],
    [{ action: "results", subagentIds: [conversationId] }, /Unknown action/],
    [{ action: "join", subagentIds: [conversationId], remove: true }, /Property remove is not allowed/],
  ] as const) {
    const parsed = parseSubagentInvocation(raw);
    assert.ok("error" in parsed);
    assert.match(parsed.error, expected);
  }
});

test("flat schema admits action fields while parser enforces associations", () => {
  for (const raw of [
    { action: "agents", state: ["active"] },
    { action: "list", spawns: [{ agent: "a", prompt: "x" }] },
    { action: "resume", spawns: [{ agent: "a", prompt: "x" }] },
    { action: "agents", subagentIds: [conversationId] },
  ]) {
    assert.equal(Check(SubagentParams, raw), true);
    assert.ok("error" in parseSubagentInvocation(raw));
  }
});

test("schema and parser reject unknown properties", () => {
  const invocation = { action: "remove", subagentIds: [conversationId], extra: true };
  assert.equal(Check(SubagentParams, invocation), false);
  assert.ok("error" in parseSubagentInvocation(invocation));
  assert.equal(Check(SpawnTaskSchema, { agent: "a", prompt: "x", extra: true }), false);
  assert.ok("error" in parseSpawnTask({ agent: "a", prompt: "x", extra: true }));
});

test("remove preserves invalid subagent targets as ordered item failures", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "remove", subagentIds: [conversationId, runId, "not-an-id"] }), {
    action: "remove",
    subagentIds: [
      conversationId,
      { subagentId: runId, error: "Unknown or invalid subagent ID." },
      { subagentId: "not-an-id", error: "Unknown or invalid subagent ID." },
    ],
  });
});
