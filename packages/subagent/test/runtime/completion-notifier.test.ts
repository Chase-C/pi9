import assert from "node:assert/strict";
import { test } from "vitest";
import { CompletionNotifier } from "../../src/runtime/completion-notifier.js";

function fixture(mode: "auto" | "steer" | "none" = "auto", idle = true, send?: (message: any, options: any) => void | Promise<void>) {
  let listener: any;
  const handlers = new Map<string, any>();
  const sent: any[] = [];
  const scheduled: Array<{ fn: () => void; delay: number; cancelled: boolean }> = [];
  const run: any = { runId: "bright-otter", createdAt: 1, observerCount: 0, acknowledged: false, status: { kind: "done", outcome: "completed", completedAt: 2, output: "SECRET" } };
  const manager: any = {
    onAgentUpdate(fn: any) { listener = fn; return () => { listener = undefined; }; },
    listConversations: () => [{ conversationId: "calm-river", config: { name: "worker" }, runs: [run] }],
  };
  const pi: any = {
    on(event: string, fn: any) { handlers.set(event, fn); },
    sendMessage(message: any, options: any) { sent.push({ message, options }); return send?.(message, options); },
  };
  const notifier = new CompletionNotifier({ pi, manager, getMode: () => mode, scheduleRetry: (fn, delay) => { const item = { fn, delay, cancelled: false }; scheduled.push(item); return () => { item.cancelled = true; }; } });
  return { run, sent, notifier, flush(maxDelay = 0) { for (;;) { const index = scheduled.findIndex(item => item.delay <= maxDelay); if (index < 0) break; const item = scheduled.splice(index, 1)[0]; if (!item.cancelled) item.fn(); } }, fire(event: string, value: unknown = {}) { handlers.get(event)?.(value, { isIdle: () => idle }); }, update(kind: string) { listener?.({}, kind); } };
}

test("notifies a terminal run once without leaking output", () => {
  const f = fixture();
  f.fire("session_start"); f.flush();
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(f.sent[0]), /SECRET/);
  f.fire("turn_end");
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("none mode and acknowledged runs are ineligible", () => {
  const none = fixture("none"); none.fire("session_start"); none.flush(); assert.equal(none.sent.length, 0); none.notifier.unsubscribe();
  const acknowledged = fixture(); acknowledged.run.acknowledged = true; acknowledged.fire("session_start"); acknowledged.flush(); assert.equal(acknowledged.sent.length, 0); acknowledged.notifier.unsubscribe();
});

test("join claim survives preparation longer than the old grace period", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolName: "subagent", args: { action: "join", runIds: [f.run.runId] } });
  f.fire("session_start"); f.flush(250); assert.equal(f.sent.length, 0);
  f.notifier.releaseJoinClaims([f.run.runId]); f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("join claim suppresses delivery and observer cancellation restores eligibility", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolName: "subagent", args: { action: "join", runIds: [f.run.runId] } });
  f.fire("session_start"); f.flush(); assert.equal(f.sent.length, 0);
  f.run.observerCount = 1; f.update("observer"); f.flush();
  f.run.observerCount = 0; f.update("observer"); f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("active steer send rejection retries with steer opportunity", async () => {
  let attempts = 0;
  const f = fixture("steer", false, () => ++attempts === 1 ? Promise.reject(new Error("closed")) : Promise.resolve());
  f.fire("session_start");
  f.fire("tool_execution_start", { toolName: "other", args: {} });
  await Promise.resolve(); await Promise.resolve();
  f.flush(500);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map(value => value.options), [{ deliverAs: "steer" }, { deliverAs: "steer" }]);
  f.notifier.unsubscribe();
});
