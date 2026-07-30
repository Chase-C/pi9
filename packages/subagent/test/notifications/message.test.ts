import { test } from "vitest";
import assert from "node:assert/strict";

import {
  createCompletionNotificationMessage,
  formatCompletionNotificationMessage,
} from "../../src/notifications.js";
const entry = {
  ok: true as const,
  subagentId: "quiet-otter",
  label: "short task",
  agent: "helper",
  status: "completed" as const,
  joined: false,
  availableActions: ["inspect", "join", "remove"] as const,
  completedAt: 2_000,
  elapsedMs: 1_250,
};

test("background completion factory creates compact tagged model content", () => {
  const message = createCompletionNotificationMessage([entry]);

  assert.deepEqual(message.details, { completions: [entry] });
  assert.equal(message.content, [
    "<subagent-notification>",
    '  <subagent subagentId="quiet-otter" status="completed" agent="helper" label="short task" joined="false" availableActions="inspect,join,remove"/>',
    "</subagent-notification>",
  ].join("\n"));
  assert.doesNotMatch(message.content, /1\.3s|subagent join/);
});

test("tagged completion content escapes attribute values", () => {
  const message = createCompletionNotificationMessage([{
    ...entry,
    subagentId: 'run<&"',
    agent: 'help&"er',
    label: '<short "task">',
  }]);

  assert.match(message.content, /subagentId="run&lt;&amp;&quot;"/);
  assert.match(message.content, /agent="help&amp;&quot;er"/);
  assert.match(message.content, /label="&lt;short &quot;task&quot;&gt;"/);
});

test("model content retains every candidate while the human renderer stays compact", () => {
  const completions = Array.from({ length: 21 }, (_, index) => ({
    ok: true as const,
    subagentId: `subagent-${index + 1}`,
    label: `task ${index + 1}`,
    agent: "helper",
    status: "completed" as const,
    joined: false,
    availableActions: ["inspect", "join", "remove"] as const,
    completedAt: index + 1,
    elapsedMs: 1_250,
  }));

  const message = createCompletionNotificationMessage(completions);

  assert.equal(message.details.completions.length, 21);
  assert.equal(message.content.match(/<subagent /g)?.length, 21);
  assert.match(message.content, /subagentId="subagent-21"/);
  assert.doesNotMatch(message.content, /subagent join|finished:/);

  const collapsed = formatCompletionNotificationMessage(message.details, false, undefined);
  assert.match(collapsed, /^21 subagents finished/);
  assert.doesNotMatch(collapsed, /subagent-1|subagent-21/);
});
