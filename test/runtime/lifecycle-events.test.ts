import { test } from "vitest";
import assert from "node:assert/strict";

import { registerSubagentLifecycleEvents } from "../../src/runtime/lifecycle-events.js";
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

test("subagent lifecycle events emit generic updates and deduplicated status milestones", () => {
  const emitted: Array<{ event: string; data: any }> = [];
  const events = { emit: (event: string, data: unknown) => emitted.push({ event, data }) };
  const driver = source();

  registerSubagentLifecycleEvents(events, driver.manager as any);

  driver.emit(fakeAgent({ id: "s1", status: { kind: "running", startedAt: 10 } }));
  driver.emit(fakeAgent({ id: "s1", status: { kind: "running", startedAt: 10 } }));
  driver.emit(fakeAgent({ id: "s1", status: { kind: "completed", startedAt: 10, completedAt: 30 } }));
  driver.emit(fakeAgent({ id: "s1", status: { kind: "completed", startedAt: 10, completedAt: 30 } }));

  assert.deepEqual(emitted.map(e => e.event), [
    "subagent:updated",
    "subagent:started",
    "subagent:updated",
    "subagent:updated",
    "subagent:completed",
    "subagent:updated",
  ]);
  assert.equal(emitted[1].data.sessionId, "s1");
  assert.equal(emitted[4].data.outcome, "completed");
});

test("subagent lifecycle events keep resumed completions observable", () => {
  const emitted: Array<{ event: string; data: any }> = [];
  const events = { emit: (event: string, data: unknown) => emitted.push({ event, data }) };
  const driver = source();

  registerSubagentLifecycleEvents(events, driver.manager as any);

  driver.emit(fakeAgent({ id: "s1", status: { kind: "completed", startedAt: 10, completedAt: 30 } }));
  driver.emit(fakeAgent({ id: "s1", status: { kind: "completed", startedAt: 40, completedAt: 80 } }));

  const completions = emitted.filter(e => e.event === "subagent:completed");
  assert.equal(completions.length, 2);
  assert.equal(completions[1].data.snapshot.status.completedAt, 80);
});
