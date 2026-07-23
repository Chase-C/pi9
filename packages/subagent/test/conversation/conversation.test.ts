import { test } from "vitest";
import assert from "node:assert/strict";
import { Conversation } from "../../src/conversation.js";
import type { ConversationId } from "../../src/identifiers.js";
import type { RunId } from "../../src/identifiers.js";

const cid = "calm-otter" as ConversationId;
const r1 = "build-boldly" as RunId;
const r2 = "seek-softly" as RunId;
const config = {
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
};
const session = () => ({ subscribe: () => () => {}, abort: () => {} }) as any;
const make = () => new Conversation(
  cid,
  r1,
  config,
  { kind: "spawn", agent: "helper", prompt: "one" },
  () => {},
);

test("preserves immutable exact run history across resume", () => {
  const agent = make();
  agent.bindSession(session());
  const first = agent.settle(r1, { status: "completed", output: "first" });
  const historical = agent.snapshot().runs[0];

  agent.beginResume(r2, "two");
  agent.bindSession(session());
  agent.settle(r2, { status: "completed", output: "second" });

  assert.deepEqual(agent.snapshot().runs.map(run => [
    run.runId,
    run.kind,
    run.status.kind === "done" && run.status.output,
  ]), [
    [r1, "spawn", "first"],
    [r2, "resume", "second"],
  ]);
  assert.deepEqual(agent.snapshot().runs[0], historical);
  assert.equal(first.status.kind, "done");
  assert.ok(Object.isFrozen(first));
});

test("resume capability requires a resumable outcome and intact context", () => {
  for (const status of ["completed", "interrupted", "error", "aborted", "skipped"] as const) {
    const agent = make();
    agent.bindSession(session());
    agent.settle(r1, status === "completed"
      ? { status, output: "ok" }
      : { status, error: status });
    assert.equal(agent.canResume, status === "completed" || status === "interrupted", status);
  }
  assert.equal(make().canResume, false, "active is not resumable");
  const noContext = make();
  noContext.settle(r1, { status: "completed", output: "never bound" });
  assert.equal(noContext.canResume, false);
});

test("logical abort terminalizes before best-effort SDK abort resolves", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const agent = make();
  agent.bindSession({ subscribe: () => () => {}, abort: () => pending } as any);
  const aborting = agent.abort("stopped");

  const status = agent.snapshot().runs[0].status;
  assert.equal(status.kind, "done");
  assert.equal(status.kind === "done" && status.outcome, "aborted");
  assert.equal(status.kind === "done" && status.error, "stopped");

  release();
  await aborting;
});

test("bindings track observers and acknowledge an exact run", () => {
  const agent = make();
  const first = agent.bindRun(r1);
  const second = agent.bindRun(r1);
  assert.equal(agent.snapshot().runs[0].observerCount, 2);
  first.release();
  second.release();
  agent.acknowledge(r1);
  assert.equal(agent.snapshot().runs[0].acknowledged, true);
});

test("nested join attempts preserve immutable owner history, target order, and duplicates", () => {
  const agent = make();
  const firstIndex = agent.beginNestedJoin(r1, [r2, r2], "call-1");
  const active = agent.snapshot().runs[0].nestedJoins![0];

  agent.updateNestedJoin(r1, firstIndex, {
    targets: [
      { runId: r2, conversationId: cid, status: "completed" },
      { runId: r2, conversationId: cid, status: "error" },
    ],
    state: "interrupted",
    error: "caller stopped waiting",
  });
  const secondIndex = agent.beginNestedJoin(r1, [r2], "call-2");
  agent.updateNestedJoin(r1, secondIndex, {
    targets: [{ runId: r2, conversationId: cid, status: "completed" }],
    state: "completed",
  });

  const attempts = agent.snapshot().runs[0].nestedJoins!;
  assert.deepEqual(active.targets.map(target => target.runId), [r2, r2], "an earlier snapshot does not change");
  assert.equal(active.state, "running");
  assert.deepEqual(attempts.map(attempt => attempt.toolCallId), ["call-1", "call-2"]);
  assert.deepEqual(attempts[0].targets.map(target => target.runId), [r2, r2]);
  assert.equal(attempts[0].state, "interrupted");
  assert.equal(attempts[0].error, "caller stopped waiting");
  assert.equal(typeof attempts[0].completedAt, "number");
  assert.equal(attempts[1].state, "completed");
  assert.equal(typeof attempts[1].completedAt, "number");
  assert.ok(Object.isFrozen(attempts));
  assert.ok(Object.isFrozen(attempts[0]));
  assert.ok(Object.isFrozen(attempts[0].targets));
  assert.ok(attempts.every(attempt => attempt.targets.every(target => !("output" in target))));
});
