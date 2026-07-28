import { test } from "vitest";
import assert from "node:assert/strict";

import {
  createCompletionNotificationMessage,
  formatCompletionNotificationMessage,
} from "../../src/notifications.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";

const entry = {
  runId: "run-1", conversationId: "conversation-1",
  agent: "helper",
  label: "short task",
  status: "completed" as const,
  elapsedMs: 1_250,
};

test("background completion factory keeps content and structured details on the same projection", () => {
  const message = createCompletionNotificationMessage([entry]);

  assert.deepEqual(message.details, { completions: [entry] });
  assert.equal(message.content, formatCompletionNotificationMessage(message.details, true, undefined));
});

test("terminal notification header stays status-neutral for aborted and mixed outcomes", () => {
  const aborted = { ...entry, status: "aborted" as const };
  const errored = { ...entry, runId: "run-2", status: "error" as const };

  assert.match(createCompletionNotificationMessage([aborted]).content, /^1 subagent finished since the last notification:/);
  assert.match(createCompletionNotificationMessage([entry, aborted, errored]).content, /^3 subagents finished since the last notification:/);
});

test("background completion content lists 20 of 21 entries with exact overflow and boundary truncation", () => {
  const display = {
    ...DEFAULT_SUBAGENT_SETTINGS.display,
    toolCallLabelMaxLength: 10,
  };
  const completions = Array.from({ length: 21 }, (_, index) => ({
    runId: `run-${index + 1}`,
    conversationId: `conversation-${index + 1}`,
    agent: "helper",
    ...(index === 0 ? { label: "abcdefghijk" } : {}),
    status: "completed" as const,
    elapsedMs: 1_250,
  }));

  const message = createCompletionNotificationMessage(completions, display);
  const lines = message.content.split("\n");

  assert.equal(message.details.completions.length, 21, "details retain every completion");
  const entries = lines.filter(line => line.includes("runId "));
  assert.equal(entries.length, 20, "content lists only 20 entries");
  assert.match(entries[0], /helper \(abcdefg\.\.\.\).*run-1.*conversation-1$/);
  assert.match(entries.at(-1)!, /run-20.*conversation-20$/);
  assert.match(message.content, /1 more/);
  assert.doesNotMatch(message.content, /run-21/);

  const collapsed = formatCompletionNotificationMessage(message.details, false, undefined);
  assert.match(collapsed, /^21 subagents finished/);
  assert.doesNotMatch(collapsed, /run-1|run-21|Call subagent results/);
});
