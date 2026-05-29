import { test } from "vitest";
import assert from "node:assert/strict";

import { confirmWithActiveSubagents, registerSubagentSessionGuards } from "../../src/runtime/session-guards.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("session guard cancels when the user rejects switching with active subagents", async () => {
  const prompts: Array<{ title: string; message: string }> = [];
  const result = await confirmWithActiveSubagents(
    {
      hasUI: true,
      ui: {
        async confirm(title, message) {
          prompts.push({ title, message });
          return false;
        },
      },
    },
    { listSessions: () => [fakeAgent({ config: { name: "helper" }, label: "audit", status: { kind: "running", startedAt: 1 } })] },
  );

  assert.deepEqual(result, { cancel: true });
  assert.equal(prompts[0].title, "Active subagents");
  assert.match(prompts[0].message, /helper \(audit\): running/);
});

test("session guard allows session changes without active subagents or without UI", async () => {
  assert.equal(
    await confirmWithActiveSubagents(
      { hasUI: true, ui: { async confirm() { throw new Error("should not ask"); } } },
      { listSessions: () => [fakeAgent({ status: { kind: "completed", completedAt: 2 } })] },
    ),
    undefined,
  );

  assert.equal(
    await confirmWithActiveSubagents(
      { hasUI: false },
      { listSessions: () => [fakeAgent({ status: { kind: "queued" } })] },
    ),
    undefined,
  );
});

test("session guards register for switch and fork events", () => {
  const events: string[] = [];
  registerSubagentSessionGuards(
    { on: (event: any) => { events.push(event); } },
    { listSessions: () => [] },
  );

  assert.deepEqual(events, ["session_before_switch", "session_before_fork"]);
});
