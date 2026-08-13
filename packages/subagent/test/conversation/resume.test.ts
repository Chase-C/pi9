import assert from "node:assert/strict";
import { test } from "vitest";
import { Conversation } from "../../src/conversation.js";
import type { ConversationId } from "../../src/identifiers.js";

const definition = { name: "helper", description: "Test helper", systemPrompt: "Help", source: "project" as const };
function conversation(): Conversation {
  return new Conversation("calm-otter" as ConversationId, definition, { kind: "spawn", agent: "helper", prompt: "Do work", label: "work" }, () => {});
}
const session = () => ({ subscribe: () => () => {} }) as any;

test("generations are numbered one-based and resume reuses the retained session", () => {
  const retained = conversation();
  const first = retained.latestGeneration;
  const retainedSession = session();
  retained.bindSession(first, retainedSession);
  assert.equal(retained.snapshot().resumeAllowed, false, "running");
  retained.settle(first, "completed", { output: "done" });
  retained.markCollected(first, "model");
  assert.equal(retained.snapshot().resumeAllowed, true);

  const second = retained.beginResume("continue");
  assert.equal(second.number, 2);
  assert.equal(second.kind, "resume");
  assert.deepEqual(retained.snapshot().generations.map(item => item.generation), [1, 2]);
  assert.equal(retained.sessionForResume(), retainedSession);
  assert.throws(() => retained.bindSession(second, session()), /must reuse its conversation session/);
  retained.bindSession(second, retainedSession);
  assert.equal(second.state.kind === "running" ? second.state.session : undefined, retainedSession);
});

test("resume eligibility requires a retained terminal, initiator receipt, and no active collection", () => {
  const unbound = conversation();
  const generation = unbound.latestGeneration;
  unbound.settle(generation, "completed", { output: "done" });
  unbound.markCollected(generation, "model");
  assert.equal(unbound.isResumeAllowed, false, "no retained session");

  const collected = conversation();
  const first = collected.latestGeneration;
  collected.bindSession(first, session());
  collected.settle(first, "completed");
  collected.markCollected(first, "user");
  assert.equal(collected.isResumeAllowed, false, "only non-initiator receipt recorded");

  const binding = collected.bindGeneration(first);
  binding.markCollected("model");
  assert.deepEqual(binding.snapshot().receipts, { user: true, model: true });
  assert.equal(binding.snapshot().activeCollectionCount, 1);
  assert.equal(collected.isResumeAllowed, false, "collection active");
  binding.release();
  assert.equal(collected.snapshot().generations[0]?.activeCollectionCount, 0);
  assert.equal(collected.isResumeAllowed, true);
});
