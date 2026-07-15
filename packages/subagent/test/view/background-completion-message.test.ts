import { test } from "vitest";
import assert from "node:assert/strict";

import {
  createBackgroundCompletionMessage,
  formatBackgroundCompletionMessage,
} from "../../src/view/background-completion-message.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";

const entry = {
  sessionId: "session-1",
  agent: "helper",
  label: "short task",
  status: "completed" as const,
  elapsedMs: 1_250,
};

test("background completion factory keeps plain content and details on the same projection", () => {
  const message = createBackgroundCompletionMessage([entry]);

  assert.deepEqual(message.details, { completions: [entry] });
  assert.equal(
    message.content,
    "1 background subagent completed since the last notification:\n"
      + "- helper (short task) · completed · 1.3s · sessionId session-1\n"
      + "\n"
      + "Call subagent results with these sessionIds to retrieve output.",
  );

  assert.equal(
    formatBackgroundCompletionMessage(message.details, true, undefined),
    "1 background subagent completed since the last notification:\n"
      + "- helper (short task) · completed · 1.3s · sessionId session-1\n"
      + "\n"
      + "Call subagent results with these sessionIds to retrieve output.",
  );
});

test("background completion content lists 20 of 21 entries with exact overflow and boundary truncation", () => {
  const display = {
    ...DEFAULT_SUBAGENT_SETTINGS.display,
    toolCallLabelMaxLength: 10,
  };
  const completions = Array.from({ length: 21 }, (_, index) => ({
    sessionId: `session-${index + 1}`,
    agent: "helper",
    ...(index === 0 ? { label: "abcdefghijk" } : {}),
    status: "completed" as const,
    elapsedMs: 1_250,
  }));

  const message = createBackgroundCompletionMessage(completions, display);
  const lines = message.content.split("\n");

  assert.equal(message.details.completions.length, 21, "details retain every completion");
  assert.equal(lines[0], "21 background subagents completed since the last notification:");
  assert.equal(lines.filter(line => line.includes("sessionId ")).length, 20, "content lists only 20 entries");
  assert.equal(lines[1], "- helper (abcdefg...) · completed · 1.3s · sessionId session-1");
  assert.equal(lines[20], "- helper · completed · 1.3s · sessionId session-20");
  assert.equal(lines[21], "- ... and 1 more");
  assert.equal(lines[22], "");
  assert.equal(lines[23], "Call subagent results with these sessionIds to retrieve output.");
  assert.doesNotMatch(message.content, /session-21/);

  const collapsed = formatBackgroundCompletionMessage(message.details, false, undefined);
  assert.match(collapsed, /^21 background subagents completed/);
  assert.doesNotMatch(collapsed, /session-1|session-21|Call subagent results/);
});
