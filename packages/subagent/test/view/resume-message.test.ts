import { test } from "vitest";
import assert from "node:assert/strict";

import { createSubagentResumeMessage } from "../../src/view/resume-message.js";

const longOutput = `done ${"x".repeat(1500)} secret-tail`;
const longPrompt = `follow up ${"y".repeat(300)} prompt-tail`;

const makeMessage = () => createSubagentResumeMessage({
  agent: "helper",
  prompt: longPrompt,
  status: "completed",
  output: longOutput,
  sessionId: "s1",
});

test("subagent resume message has the expected shape and identifies itself", () => {
  const message = makeMessage();
  assert.equal(message.customType, "subagent-resume");
  assert.equal(message.display, true);
  assert.match(message.content, /Subagent resume completed/);
  assert.match(message.content, /agent: helper/);
  assert.match(message.content, /session: s1/);
  assert.match(message.content, /prompt: follow up/);
  assert.match(message.content, /output: done/);
});

test("subagent resume message truncates both prompt and output in the displayed content", () => {
  const message = makeMessage();
  assert.equal(message.content.includes("prompt-tail"), false);
  assert.equal(message.content.includes("secret-tail"), false);
  assert.ok(message.content.length < 700, `content length should stay tight, got ${message.content.length}`);
  assert.equal(message.details.promptPreview.includes("prompt-tail"), false);
  assert.equal(message.details.outputSnippet!.includes("secret-tail"), false);
});

test("subagent resume message preserves the full result in details for structured consumers", () => {
  const message = makeMessage();
  assert.equal((message.details.result as { output: string }).output, longOutput);
});
