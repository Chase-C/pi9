import { test } from "vitest";
import assert from "node:assert/strict";
import { parseSubagentInvocation, SUBAGENT_ACTIONS } from "../../src/schema.js";
import { errorResult } from "../../src/tool.js";

const conversationId = "amber-acorn";

test("spawn and resume are separate ordered batch actions", () => {
  assert.deepEqual(SUBAGENT_ACTIONS, ["agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", "remove"]);
  assert.deepEqual(parseSubagentInvocation({ action: "spawn", spawns: [{ agent: "helper", prompt: "work" }] }), {
    action: "spawn",
    spawns: [{ kind: "spawn", agent: "helper", prompt: "work" }],
  });
  assert.deepEqual(parseSubagentInvocation({ action: "resume", resumes: [{ conversationId, prompt: "continue" }] }), {
    action: "resume",
    resumes: [{ kind: "resume", conversationId, prompt: "continue" }],
  });
  assert.ok("error" in parseSubagentInvocation({ action: "run", spawns: [{ agent: "helper", prompt: "work" }] }));
});

test("command errors omit the ambiguous top-level ok property", () => {
  const response = JSON.parse(errorResult("bad request", "spawn" as any).content[0].text);
  assert.deepEqual(response, { action: "spawn", error: "bad request" });
});

test("malformed removal targets remain ordered item failures", () => {
  assert.deepEqual(parseSubagentInvocation({
    action: "remove",
    conversationIds: [conversationId, "not-a-real-conversation"],
  }), {
    action: "remove",
    conversationIds: [
      conversationId,
      {
        conversationId: "not-a-real-conversation",
        error: "remove received invalid conversationId format 'not-a-real-conversation'.",
      },
    ],
  });
});
