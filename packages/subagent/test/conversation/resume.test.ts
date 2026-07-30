import assert from "node:assert/strict";
import { test } from "vitest";
import { Conversation } from "../../src/conversation.js";
import type { ConversationId, RunId } from "../../src/identifiers.js";

const conversationId = "calm-otter" as ConversationId;
const runId = "build-boldly" as RunId;
const definition = {
  name: "helper",
  description: "Test helper",
  systemPrompt: "Help",
  source: "project" as const,
};

function conversation(): Conversation {
  return new Conversation(
    conversationId,
    runId,
    definition,
    { kind: "spawn", agent: "helper", prompt: "Do work", label: "work" },
    () => {},
  );
}

const session = () => ({ subscribe: () => () => {} }) as any;

test("snapshot resumeAllowed follows retained session and join state", () => {
  const retained = conversation();
  retained.bindSession(session());
  assert.equal(retained.snapshot().resumeAllowed, false, "running");

  retained.settle(runId, "completed", { output: "done" });
  assert.equal(retained.snapshot().resumeAllowed, false, "completed but not joined");

  retained.markJoined(runId);
  assert.equal(retained.snapshot().resumeAllowed, true, "completed, joined, and session retained");

  const unbound = conversation();
  unbound.settle(runId, "completed", { output: "done" });
  unbound.markJoined(runId);
  assert.equal(unbound.snapshot().resumeAllowed, false, "no session was bound");
});
