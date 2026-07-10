import { test } from "vitest";
import assert from "node:assert/strict";

import { projectSubagentSessionIndex, registerSubagentMetadataPersistence } from "../../src/runtime/session-metadata.js";
import { fakeAgent } from "../helpers/fake-agent.js";

function source() {
  let listener: any;
  return {
    manager: {
      onAgentUpdate(fn: any) {
        listener = fn;
        return () => { listener = undefined; };
      },
    },
    emit(snapshot: any, kind = "status") {
      listener({ snapshot: () => snapshot }, kind);
    },
  };
}

test("subagent metadata persistence appends one custom entry per terminal attempt", () => {
  const entries: Array<{ customType: string; data: any }> = [];
  const driver = source();
  registerSubagentMetadataPersistence(
    { appendEntry: (customType, data) => entries.push({ customType, data }) },
    driver.manager as any,
  );

  const first = fakeAgent({
    id: "s1",
    label: "audit",
    prompt: "follow up on this long prompt",
    status: { kind: "completed", startedAt: 10, completedAt: 30, response: "done" },
  });
  driver.emit(first);
  driver.emit(first);
  driver.emit(fakeAgent({ id: "s1", status: { kind: "completed", startedAt: 40, completedAt: 80, response: "done again" } }));

  assert.equal(entries.length, 2);
  assert.equal(entries[0].customType, "subagent-session-index");
  assert.deepEqual(entries[0].data, {
    version: 1,
    sessionId: "s1",
    agent: "helper",
    label: "audit",
    status: "completed",
    dispatch: "foreground",
    retention: "transient",
    completedAt: 30,
    startedAt: 10,
    elapsedMs: 20,
    promptPreview: "follow up on this long prompt",
    outputSnippet: "done",
  });
});

test("subagent metadata projection compacts prompt and error fields", () => {
  const data = projectSubagentSessionIndex(
    fakeAgent({
      id: "s2",
      prompt: `prompt ${"x".repeat(300)}`,
      status: { kind: "error", startedAt: 5, completedAt: 8, error: `boom ${"y".repeat(1500)}` },
    }) as any,
    { promptPreviewLength: 20, outputSnippetLength: 30 } as any,
  );

  assert.equal(data.promptPreview!.length <= 20, true);
  assert.equal(data.errorSnippet!.length <= 30, true);
  assert.equal(data.status, "error");
});
