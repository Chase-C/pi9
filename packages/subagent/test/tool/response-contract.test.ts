import { test } from "vitest";
import assert from "node:assert/strict";
import { parseSubagentInvocation, SUBAGENT_ACTIONS } from "../../src/schema.js";
import { errorResult } from "../../src/tool.js";

const conversationId = "amber-acorn";

test("spawn and resume are separate ordered batch actions", () => {
  assert.deepEqual(SUBAGENT_ACTIONS, ["agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", "remove"]);
  assert.deepEqual(parseSubagentInvocation({ action: "spawn", spawns: [{ agent: "helper", prompt: "work", label: "task" }] }), {
    action: "spawn",
    spawns: [{ kind: "spawn", agent: "helper", prompt: "work", label: "task" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "resume", resumes: [{ subagentId: conversationId, prompt: "continue" }] }), {
    action: "resume",
    resumes: [{ kind: "resume", subagentId: conversationId, prompt: "continue" }],
  });
  assert.ok("error" in parseSubagentInvocation({ action: "run", spawns: [{ agent: "helper", prompt: "work" }] }));
});

test("command errors omit the ambiguous top-level ok property", () => {
  const result = errorResult("bad request", "spawn" as any);
  const response = JSON.parse(result.content[0].text);
  assert.deepEqual(response, { action: "spawn", error: "bad request" });
  assert.deepEqual(result.details, { response });
});

test("malformed removal targets remain ordered item failures", () => {
  assert.deepEqual(parseSubagentInvocation({
    action: "remove",
    subagentIds: [conversationId, "not-a-real-conversation"],
  }), {
    action: "remove",
    subagentIds: [
      conversationId,
      {
        subagentId: "not-a-real-conversation",
        error: "Invalid subagentId format: not-a-real-conversation.",
      },
    ],
  });
});
