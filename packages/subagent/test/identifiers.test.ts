import assert from "node:assert/strict";
import { test } from "vitest";

import { isConversationId } from "../src/identifiers.js";
import {
  CONVERSATION_ID_ADJECTIVES,
  CONVERSATION_ID_NOUNS,
  RUN_ID_ADVERBS,
  RUN_ID_VERBS,
} from "../src/identifier-word-lists.js";
import { ConversationIdAllocator } from "../src/identifiers.js";
import { RunIdAllocator } from "../src/identifiers.js";

test("allocates distinct ID shapes", () => {
  const conversationId = new ConversationIdAllocator(() => 0).allocate();
  const runId = new RunIdAllocator(() => 0).allocate();

  assert.equal(conversationId, "airy-acorn");
  assert.equal(runId, "adapt-ably");
  assert.equal(isConversationId(conversationId), true);
  assert.equal(isConversationId(runId), false);
  assert.equal(isConversationId("amber-ably"), false);
});

test("word lists are globally disjoint", () => {
  const allWords = [
    ...CONVERSATION_ID_ADJECTIVES, ...CONVERSATION_ID_NOUNS, ...RUN_ID_VERBS, ...RUN_ID_ADVERBS,
  ];
  assert.equal(new Set(allWords).size, allWords.length);
});

test("word lists are sorted alphabetically", () => {
  for (const words of [
    CONVERSATION_ID_ADJECTIVES, CONVERSATION_ID_NOUNS, RUN_ID_VERBS, RUN_ID_ADVERBS,
  ]) {
    assert.deepEqual(words, [...words].sort());
  }
});

test("retries collisions then falls back deterministically in each namespace", () => {
  for (const [allocator, first, second] of [
    [new ConversationIdAllocator(() => 0), "airy-acorn", "airy-alpaca"],
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
