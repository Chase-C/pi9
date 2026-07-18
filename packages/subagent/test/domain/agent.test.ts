import { test } from "vitest";
import assert from "node:assert/strict";
import { Agent } from "../../src/domain/agent.js";
import { toResult } from "../../src/domain/agent-result.js";
import type { ConversationId } from "../../src/domain/conversation-id.js";
import type { RunId } from "../../src/domain/run-id.js";

const cid = "calm-otter" as ConversationId;
const r1 = "build-boldly" as RunId;
const r2 = "seek-softly" as RunId;
const config = { retainConversation: false, name: "helper", description: "d", systemPrompt: "s", source: "project" as const };
const session = () => ({ subscribe: () => () => {}, abort: () => {} }) as any;
const make = () => new Agent(cid, r1, config, { kind: "spawn", agent: "helper", prompt: "one" }, () => {});

test("preserves immutable exact run history and stable old results across resume", async () => {
  const agent = make();
  agent.bindSession(session());
  const oldBinding = agent.bindRun(r1);
  const first = agent.settle(agent.latestRunId, { status: "completed", output: "first" });
  assert.deepEqual(await oldBinding.result, { status: "completed", output: "first" });
  const oldResult = toResult(agent.snapshot(), r1);

  agent.beginResume(r2, "two");
  agent.bindSession(session());
  agent.settle(agent.latestRunId, { status: "completed", output: "second" });

  assert.deepEqual(agent.snapshot().runs.map(r => [r.runId, r.kind, r.status.kind === "done" && r.status.output]), [
    [r1, "spawn", "first"], [r2, "resume", "second"],
  ]);
  assert.deepEqual(toResult(agent.snapshot(), r1), oldResult);
  assert.equal(first.status.kind, "done");
  assert.ok(Object.isFrozen(first));
});

test("resume capability is only latest completed or interrupted with intact context", () => {
  for (const status of ["completed", "interrupted", "error", "aborted", "skipped"] as const) {
    const agent = make();
    agent.bindSession(session());
    agent.settle(r1, status === "completed" ? { status, output: "ok" } : { status, error: status });
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
  const bound = agent.bindRun(r1);
  const aborting = agent.abort("stopped");
  assert.deepEqual(await bound.result, { status: "aborted", error: "stopped" });
  assert.equal(agent.status.kind === "done" && agent.status.outcome, "aborted");
  release();
  await aborting;
});

test("bindings share one promise and acknowledgement is exact-run metadata", () => {
  const agent = make();
  const a = agent.bindRun(r1), b = agent.bindRun(r1);
  assert.equal(a.result, b.result);
  assert.equal(agent.snapshot().runs[0].observerCount, 2);
  a.release();
  agent.acknowledge(r1);
  assert.equal(agent.snapshot().runs[0].acknowledged, true);
  assert.equal(agent.snapshot().runs[0].notification, "notified");
});
