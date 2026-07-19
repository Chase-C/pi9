import { test } from "vitest";
import assert from "node:assert/strict";
import { Agent } from "../../src/domain/agent.js";
import type { ConversationId } from "../../src/domain/conversation-id.js";
import type { RunId } from "../../src/domain/run-id.js";

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
const make = () => new Agent(
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
