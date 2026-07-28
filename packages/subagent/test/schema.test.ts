import { test } from "vitest";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { SubagentParams, TaskSchema, parseSubagentInvocation, parseTask, SUBAGENT_ACTIONS } from "../src/schema.js";

const conversationId = "amber-acorn";
const runId = "adapt-ably";

test("public schema is flat and validates task structure", () => {
  assert.deepEqual(SUBAGENT_ACTIONS, ["agents", "list", "dispatch", "inspect", "join", "remove"]);
  assert.doesNotMatch(JSON.stringify(SubagentParams), /"anyOf"/);
  assert.equal(Check(SubagentParams, { action: "agents" }), true);
  assert.equal(Check(SubagentParams, { action: "unknown" }), false);
  assert.equal(Check(SubagentParams, { action: "dispatch", tasks: [] }), false);
  assert.equal(Check(SubagentParams, { action: "dispatch", tasks: {} }), false);
  assert.equal(Check(SubagentParams, { action: "dispatch", tasks: [{ agent: "helper", prompt: "work" }] }), true);
  assert.equal(Check(SubagentParams, { action: "dispatch", tasks: [{ agent: 42, prompt: true }, null] }), false);
  assert.equal(Check(SubagentParams, { action: "inspect", runIds: [runId] }), true);
  assert.equal(Check(TaskSchema, { conversationId, prompt: "continue" }), true);
  assert.equal(Check(TaskSchema, { runId, prompt: "redirect" }), true);
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

test("steer accepts a runId and prompt only", () => {
  assert.deepEqual(parseTask({ runId, prompt: "change direction" }), {
    kind: "steer", runId, prompt: "change direction",
  });
  const wrongKind = parseTask({ runId: conversationId, prompt: "change direction" });
  assert.ok("error" in wrongKind); assert.match(wrongKind.error, /conversation ID is not accepted/);
  const malformed = parseTask({ runId: "not-an-id", prompt: "change direction" });
  assert.ok("error" in malformed); assert.match(malformed.error, /invalid runId format/);
  const extra = parseTask({ runId, prompt: "change direction", model: "x" });
  assert.ok("error" in extra); assert.match(extra.error, /rejects model/);
  assert.ok("error" in parseTask({ agent: "helper", runId, prompt: "ambiguous" }));
});

test("tasks validate shape, blanks, and overrides", () => {
  for (const task of [null, { prompt: "x" }, { agent: "", prompt: "x" }, { agent: "a", prompt: " " }, { agent: "a", prompt: "x", skills: [""] }, { agent: "a", prompt: "x", thinking: "extreme" }]) assert.ok("error" in parseTask(task));
});

test("resume conversationId diagnostics distinguish ID kinds from invalid formats", () => {
  assert.deepEqual(parseTask({ conversationId, prompt: "next" }), {
    kind: "resume", conversationId, prompt: "next",
  });

  const wrongKind = parseTask({ conversationId: runId, prompt: "next" });
  assert.ok("error" in wrongKind);
  assert.match(wrongKind.error, /run ID is not accepted/);

  const malformed = parseTask({ conversationId: "not-an-id", prompt: "next" });
  assert.ok("error" in malformed);
  assert.match(malformed.error, /invalid conversationId format/);
  assert.doesNotMatch(malformed.error, /run ID is not accepted/);
});

test("invocations parse every action without aliases", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "agents" }), { action: "agents" });
  assert.deepEqual(parseSubagentInvocation({ action: "list", status: ["running"] }), { action: "list", status: ["running"] });
  assert.deepEqual(parseSubagentInvocation({ action: "dispatch", tasks: [{ agent: "helper", prompt: "x" }] }), {
    action: "dispatch",
    tasks: [{ kind: "spawn", agent: "helper", prompt: "x" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "inspect", runIds: [runId] }), { action: "inspect", runIds: [runId] });
  assert.deepEqual(parseSubagentInvocation({ action: "join", runIds: [runId] }), { action: "join", runIds: [runId] });
  assert.deepEqual(parseSubagentInvocation({ action: "remove", conversationIds: [conversationId] }), { action: "remove", conversationIds: [conversationId] });
});

test("task parse failures remain indexed within a runnable batch", () => {
  const parsed = parseSubagentInvocation({
    action: "dispatch",
    tasks: [
      { agent: "helper", prompt: "first" },
      { prompt: "missing agent" },
      { conversationId, prompt: "third" },
    ],
  });
  assert.deepEqual(parsed, {
    action: "dispatch",
    tasks: [
      { kind: "spawn", agent: "helper", prompt: "first" },
      { error: "Task must carry exactly one of agent (spawn), conversationId (resume), or runId (steer)." },
      { kind: "resume", conversationId, prompt: "third" },
    ],
  });
});

test("whole invocation validation covers limits, status, and required batches", () => {
  assert.ok("error" in parseSubagentInvocation({}));
  assert.ok("error" in parseSubagentInvocation({ action: "unknown" }));
  assert.ok("error" in parseSubagentInvocation({ action: "list", status: ["stale"] }));
  assert.ok("error" in parseSubagentInvocation({ action: "dispatch" }));
  assert.ok("error" in parseSubagentInvocation({ action: "dispatch", tasks: [] }));
  assert.match((parseSubagentInvocation({ action: "dispatch", tasks: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }] }, { maxTasks: 1 }) as any).error, /Too many/);
  assert.ok("error" in parseSubagentInvocation({ action: "inspect", runIds: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "join", runIds: [] }));
  assert.ok("error" in parseSubagentInvocation({ action: "remove" }));
});

test("join and remove ID diagnostics distinguish ID kinds from invalid formats", () => {
  assert.deepEqual(parseSubagentInvocation({ action: "join", runIds: [runId] }), {
    action: "join", runIds: [runId],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "remove", conversationIds: [conversationId] }), {
    action: "remove", conversationIds: [conversationId],
  });

  const wrongJoin = parseSubagentInvocation({ action: "join", runIds: [conversationId] });
  assert.ok("error" in wrongJoin);
  assert.match(wrongJoin.error, /conversation ID is not accepted/);
  const malformedJoin = parseSubagentInvocation({ action: "join", runIds: ["not-an-id"] });
  assert.ok("error" in malformedJoin);
  assert.match(malformedJoin.error, /invalid runId format/);
  assert.doesNotMatch(malformedJoin.error, /conversation ID is not accepted/);

  const wrongRemove = parseSubagentInvocation({ action: "remove", conversationIds: [runId] });
  assert.ok("error" in wrongRemove);
  assert.match(wrongRemove.error, /run ID is not accepted/);
  const malformedRemove = parseSubagentInvocation({ action: "remove", conversationIds: ["not-an-id"] });
  assert.ok("error" in malformedRemove);
  assert.match(malformedRemove.error, /invalid conversationId format/);
  assert.doesNotMatch(malformedRemove.error, /run ID is not accepted/);
});

test("flat schema admits action fields while the parser enforces their associations", () => {
  for (const raw of [
    { action: "agents", status: ["running"] },
    { action: "list", tasks: [{ agent: "a", prompt: "x" }] },
    { action: "join", runIds: [runId], conversationIds: [conversationId] },
  ]) {
    assert.equal(Check(SubagentParams, raw), true);
    assert.ok("error" in parseSubagentInvocation(raw));
  }

  const mixedTask = { conversationId, prompt: "x", label: "no" };
  assert.equal(Check(TaskSchema, mixedTask), true);
  assert.ok("error" in parseTask(mixedTask));
});

test("schema and parser reject unknown properties", () => {
  const invocation = { action: "remove", conversationIds: [conversationId], extra: true };
  assert.equal(Check(SubagentParams, invocation), false);
  assert.ok("error" in parseSubagentInvocation(invocation));

  const task = { agent: "a", prompt: "x", extra: true };
  assert.equal(Check(TaskSchema, task), false);
  assert.ok("error" in parseTask(task));
});

test("unsupported actions and invocation fields receive ordinary validation errors", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ action: "dispatch", tasks: [], background: true }, /Property background is not allowed/],
    [{ action: "dispatch", tasks: [], mode: "background" }, /Property mode is not allowed/],
    [{ action: "inspect", runIds: [runId], wait: true }, /Property wait is not allowed/],
    [{ action: "run", tasks: [] }, /Unknown action/],
    [{ action: "results", runIds: [runId] }, /Unknown action/],
    [{ action: "join", runIds: [runId], results: true }, /Property results is not allowed/],
    [{ action: "join", runIds: [runId], remove: true }, /Property remove is not allowed/],
  ];
  for (const [raw, expected] of cases) {
    const parsed = parseSubagentInvocation(raw);
    assert.ok("error" in parsed);
    assert.match(parsed.error, expected);
  }
});

test("unsupported task fields produce per-task parse failures", () => {
  for (const [task, expected] of [
    [{ sessionId: conversationId, prompt: "x" }, /sessionId is not allowed/],
    [{ agent: "a", prompt: "x", retainConversation: true }, /retainConversation is not allowed/],
  ] as const) {
    const parsed = parseSubagentInvocation({ action: "dispatch", tasks: [task] });
    assert.ok("tasks" in parsed);
    const failure = parsed.tasks[0];
    assert.ok(failure && "error" in failure);
    assert.match(failure.error, expected);
  }
});
