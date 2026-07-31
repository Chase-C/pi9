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
  retained.markJoined(first);
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

test("resume eligibility requires a retained terminal, joined, unobserved generation", () => {
  const unbound = conversation();
  const generation = unbound.latestGeneration;
  unbound.settle(generation, "completed", { output: "done" });
  unbound.markJoined(generation);
  assert.equal(unbound.isResumeAllowed, false, "no retained session");

  const observed = conversation();
  const first = observed.latestGeneration;
  observed.bindSession(first, session());
  observed.settle(first, "completed");
  const binding = observed.bindGeneration(first);
  binding.markJoined();
  assert.equal(observed.isResumeAllowed, false, "observer attached");
  binding.release();
  assert.equal(observed.isResumeAllowed, true);
});
