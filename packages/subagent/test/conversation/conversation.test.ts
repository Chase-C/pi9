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

test("preserves only explicit spawn model and thinking overrides", () => {
  const inherited = make().snapshot();
  const overridden = new Conversation(
    cid,
    r1,
    { ...config, model: "agent-default" },
    { kind: "spawn", agent: "helper", prompt: "one", model: "task-model", thinking: "high" },
    () => {},
  ).snapshot();

  assert.equal(inherited.requestedOverrides, undefined);
  assert.deepEqual(overridden.requestedOverrides, { model: "task-model", thinking: "high" });
  assert.equal(overridden.config.model, "task-model");
});

test("a newly attached run reports the starting phase", () => {
  const agent = make();
  agent.bindSession(session());

  assert.equal(agent.snapshot().runs[0].activity.phase, "starting");
});

test("session events expose the current running phase", async () => {
  let emit!: (event: any) => void;
  const agent = make();
  agent.bindSession({
    subscribe(listener: (event: any) => void) { emit = listener; return () => {}; },
    async steer() {},
    getSteeringMessages: () => ["redirect"],
  } as any);
  const phase = () => agent.snapshot().runs[0].activity.phase;

  emit({ type: "turn_start" });
  assert.equal(phase(), "thinking");
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  assert.equal(phase(), "responding");
  emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
  assert.equal(phase(), "executing_tool");
  emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", isError: false });
  assert.equal(phase(), "thinking");

  await agent.steer(r1, "redirect");
  emit({ type: "message_start", message: { role: "user", content: "redirect" } });
  assert.equal(phase(), "processing_steer");
  emit({ type: "agent_end", messages: [], willRetry: true });
  assert.equal(phase(), "thinking");
  emit({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(phase(), "settling");
});

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
    assert.equal(agent.canResume, status === "completed" || status === "interrupted" || status === "aborted", status);
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
  assert.equal(agent.canResume, false);

  agent.executionSettled(r1);
  assert.equal(agent.canResume, false);
  release();
  await aborting;
  assert.equal(agent.canResume, true);
});

test("steer receipts become delivered when the queued user message enters the turn", async () => {
  let emit!: (event: any) => void;
  const steering: string[] = [];
  const agent = make();
  agent.bindSession({
    subscribe(listener: (event: any) => void) { emit = listener; return () => {}; },
    async steer(prompt: string) { steering.push(prompt); },
    getSteeringMessages: () => steering,
  } as any);

  await agent.steer(r1, "redirect");
  assert.equal(agent.snapshot().runs[0].steers[0].state, "queued");

  emit({ type: "message_start", message: { role: "user", content: "redirect" } });

  const receipt = agent.snapshot().runs[0].steers[0];
  assert.equal(receipt.state, "delivered");
  assert.equal(typeof receipt.deliveredAt, "number");
});

test("delivered steer receipts become processed when the assistant response starts", async () => {
  let emit!: (event: any) => void;
  const agent = make();
  agent.bindSession({
    subscribe(listener: (event: any) => void) { emit = listener; return () => {}; },
    async steer() {},
    getSteeringMessages: () => ["redirect"],
  } as any);

  await agent.steer(r1, "redirect");
  emit({ type: "message_start", message: { role: "user", content: "redirect" } });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });

  const receipt = agent.snapshot().runs[0].steers[0];
  assert.equal(receipt.state, "processed");
  assert.equal(typeof receipt.processedAt, "number");
});

test("duplicate steer messages are delivered in FIFO order", async () => {
  let emit!: (event: any) => void;
  const steering: string[] = [];
  const agent = make();
  agent.bindSession({
    subscribe(listener: (event: any) => void) { emit = listener; return () => {}; },
    async steer(prompt: string) { steering.push(prompt); },
    getSteeringMessages: () => steering,
  } as any);

  await agent.steer(r1, "same");
  await agent.steer(r1, "same");
  emit({ type: "message_start", message: { role: "user", content: "same" } });
  assert.deepEqual(agent.snapshot().runs[0].steers.map(steer => steer.state), ["delivered", "queued"]);

  emit({ type: "message_start", message: { role: "user", content: "same" } });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  assert.deepEqual(agent.snapshot().runs[0].steers.map(steer => steer.state), ["processed", "processed"]);
});

test("concurrent steer calls keep receipts correlated with their queued messages", async () => {
  let emit!: (event: any) => void;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const steering: string[] = [];
  const agent = make();
  agent.bindSession({
    subscribe(listener: (event: any) => void) { emit = listener; return () => {}; },
    async steer(prompt: string) { steering.push(prompt); await gate; },
    getSteeringMessages: () => steering,
  } as any);

  const first = agent.steer(r1, "first");
  const second = agent.steer(r1, "second");
  release();
  await Promise.all([first, second]);
  emit({ type: "message_start", message: { role: "user", content: "first" } });
  emit({ type: "message_start", message: { role: "user", content: "second" } });

  assert.deepEqual(agent.snapshot().runs[0].steers.map(steer => steer.state), ["delivered", "delivered"]);
});

test("a steer accepted while the run settles returns a discarded receipt", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const agent = make();
  agent.bindSession({
    subscribe: () => () => {},
    async steer() { await gate; },
    getSteeringMessages: () => ["redirect"],
  } as any);

  const steering = agent.steer(r1, "redirect");
  await Promise.resolve();
  agent.settle(r1, { status: "aborted", error: "stopped" });
  release();

  assert.equal((await steering).state, "discarded");
  assert.equal(agent.snapshot().runs[0].steers[0].state, "discarded");
});

test("settling a run discards steer receipts that were not processed", async () => {
  const agent = make();
  agent.bindSession({
    subscribe: () => () => {},
    async steer() {},
    getSteeringMessages: () => ["redirect"],
  } as any);
  await agent.steer(r1, "redirect");

  agent.settle(r1, { status: "aborted", error: "stopped" });

  assert.equal(agent.snapshot().runs[0].steers[0].state, "discarded");
});

test("new steers reject without reaching the SDK once shutdown starts", async () => {
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>(resolve => { releaseAbort = resolve; });
  let steerCalls = 0;
  const agent = make();
  agent.bindSession({
    subscribe: () => () => {},
    async steer() { steerCalls++; },
    clearQueue() { return { steering: [], followUp: [] }; },
    abort: () => abortGate,
  } as any);

  const aborting = agent.abort("stopped");
  await assert.rejects(agent.steer(r1, "too late"), /stopping/);
  assert.equal(steerCalls, 0);

  releaseAbort();
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
