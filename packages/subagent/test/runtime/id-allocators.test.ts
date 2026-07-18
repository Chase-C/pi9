import assert from "node:assert/strict";
import { test } from "vitest";

import { isConversationId } from "../../src/domain/conversation-id.js";
import {
  CONVERSATION_ID_ADJECTIVES,
  CONVERSATION_ID_NOUNS,
  RUN_ID_ADVERBS,
  RUN_ID_VERBS,
} from "../../src/domain/identifier-word-lists.js";
import { isRunId } from "../../src/domain/run-id.js";
import { ConversationIdAllocator } from "../../src/runtime/conversation-id-allocator.js";
import { RunIdAllocator } from "../../src/runtime/run-id-allocator.js";

test("allocates distinct recognizable ID shapes", () => {
  const conversationId = new ConversationIdAllocator(() => 0).allocate();
  const runId = new RunIdAllocator(() => 0).allocate();

  assert.equal(conversationId, "amber-acorn");
  assert.equal(runId, "adapt-ably");
  assert.equal(isConversationId(conversationId), true);
  assert.equal(isRunId(conversationId), false);
  assert.equal(isRunId(runId), true);
  assert.equal(isConversationId(runId), false);
  assert.equal(isConversationId("amber-ably"), false);
  assert.equal(isRunId("adapt-acorn"), false);
});

test("word lists are globally disjoint", () => {
  const allWords = [
    ...CONVERSATION_ID_ADJECTIVES, ...CONVERSATION_ID_NOUNS, ...RUN_ID_VERBS, ...RUN_ID_ADVERBS,
  ];
  assert.equal(new Set(allWords).size, allWords.length);
});

test("retries collisions then falls back deterministically in each namespace", () => {
  for (const [allocator, first, second] of [
    [new ConversationIdAllocator(() => 0), "amber-acorn", "amber-antelope"],
    [new RunIdAllocator(() => 0), "adapt-ably", "adapt-abruptly"],
  ] as const) {
    assert.equal(allocator.allocate(), first);
    assert.equal(allocator.allocate(), second);
  }
});

test("exhausts each finite namespace without duplicates", () => {
  for (const [allocator, size] of [
    [new ConversationIdAllocator(() => 0), CONVERSATION_ID_ADJECTIVES.length * CONVERSATION_ID_NOUNS.length],
    [new RunIdAllocator(() => 0), RUN_ID_VERBS.length * RUN_ID_ADVERBS.length],
  ] as const) {
    const ids = Array.from({ length: size }, () => allocator.allocate());
    assert.equal(new Set(ids).size, size);
    assert.equal(allocator.allocate(), undefined);
  }
});
