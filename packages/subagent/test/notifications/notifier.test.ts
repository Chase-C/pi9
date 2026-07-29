import assert from "node:assert/strict";
import { test } from "vitest";
import { CompletionNotifier } from "../../src/notifications.js";

function fixture(mode: "auto" | "steer" | "none" = "auto", idle = true, send?: (message: any, options: any) => void | Promise<void>) {
  let listener: any;
  const handlers = new Map<string, any>();
  const sent: any[] = [];
  const scheduled: Array<{ fn: () => void; delay: number; cancelled: boolean }> = [];
  const run: any = { runId: "bright-otter", createdAt: 1, observerCount: 0, acknowledged: false, status: { kind: "done", outcome: "completed", completedAt: 2, output: "SECRET" } };
  const conversations: any[] = [{ conversationId: "calm-river", config: { name: "worker" }, runs: [run] }];
  const manager: any = {
    onConversationUpdate(fn: any) { listener = fn; return () => { listener = undefined; }; },
    listConversations: () => conversations,
    runSnapshot: (runId: string) => conversations.flatMap(value => value.runs).find(value => value.runId === runId) ?? run,
  };
  const pi: any = {
    on(event: string, fn: any) { handlers.set(event, fn); },
    sendMessage(message: any, options: any) { sent.push({ message, options }); return send?.(message, options); },
  };
  const notifier = new CompletionNotifier({ pi, manager, getMode: () => mode, scheduleRetry: (fn, delay) => { const item = { fn, delay, cancelled: false }; scheduled.push(item); return () => { item.cancelled = true; }; } });
  return { run, conversations, sent, scheduled, notifier, flush(maxDelay = 0) { for (;;) { const index = scheduled.findIndex(item => item.delay <= maxDelay); if (index < 0) break; const item = scheduled.splice(index, 1)[0]; if (!item.cancelled) item.fn(); } }, fire(event: string, value: unknown = {}) { handlers.get(event)?.(value, { isIdle: () => idle }); }, update(kind: string, updatedRun: any = run) { listener?.({ snapshot: () => ({ runs: [updatedRun] }) }, kind); } };
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

test("joined descendants stay silent while detached descendants remain eligible", () => {
  const f = fixture();
  f.run.acknowledged = true;
  const detached: any = { runId: "wander-widely", createdAt: 1, observerCount: 0, acknowledged: false, status: { kind: "done", outcome: "completed", completedAt: 2 } };
  f.conversations.push({ conversationId: "young-maple", config: { name: "worker" }, runs: [detached] });
  f.fire("session_start"); f.flush();
  assert.deepEqual(f.sent[0].message.details.completions.map((entry: any) => entry.runId), [detached.runId]);
  f.notifier.unsubscribe();
});

test("none mode and acknowledged runs are ineligible", () => {
  const none = fixture("none"); none.fire("session_start"); none.flush(); assert.equal(none.sent.length, 0); none.notifier.unsubscribe();
  const acknowledged = fixture(); acknowledged.run.acknowledged = true; acknowledged.fire("session_start"); acknowledged.flush(); assert.equal(acknowledged.sent.length, 0); acknowledged.notifier.unsubscribe();
});

test("tool execution end releases claims when execution was rejected before the tool ran", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "blocked-call", toolName: "subagent", args: { action: "inspect", runIds: [f.run.runId] } });
  f.fire("session_start"); f.flush();
  assert.equal(f.sent.length, 0);
  f.fire("tool_execution_end", { toolCallId: "blocked-call", toolName: "subagent", isError: true, result: { content: [], details: {} } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("overlapping tool calls retain independent claims on the same run", () => {
  const f = fixture();
  for (const toolCallId of ["inspect-one", "inspect-two"]) {
    f.fire("tool_execution_start", { toolCallId, toolName: "subagent", args: { action: "inspect", runIds: [f.run.runId] } });
  }
  f.fire("session_start"); f.flush();
  f.fire("tool_execution_end", { toolCallId: "inspect-one", toolName: "subagent", result: { content: [], details: {} } });
  f.flush();
  assert.equal(f.sent.length, 0);
  f.fire("tool_execution_end", { toolCallId: "inspect-two", toolName: "subagent", result: { content: [], details: {} } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("join claim survives preparation longer than the old grace period", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "join-call", toolName: "subagent", args: { action: "join", runIds: [f.run.runId] } });
  f.fire("session_start"); f.flush(250); assert.equal(f.sent.length, 0);
  f.fire("tool_execution_end", { toolCallId: "join-call", toolName: "subagent", result: { content: [], details: {} } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("recursive cancel holds its descendant claim through grace and marks the outcome observed", () => {
  const f = fixture();
  f.run.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  f.notifier.beginTool("child:delegate-boldly", "cancel-descendant", { action: "cancel", runIds: [f.run.runId] });
  f.run.status = { kind: "done", outcome: "aborted", startedAt: 1, completedAt: 2, error: "Run cancelled." };
  f.update("status"); f.flush(500);
  assert.equal(f.sent.length, 0);

  f.notifier.completeTool("child:delegate-boldly", "cancel-descendant", { content: [], details: { action: "cancel", runs: [{ runId: f.run.runId, status: "aborted" }] } });
  f.flush();
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("finalized results cannot mark unclaimed runs observed", () => {
  const f = fixture();
  const unrelated: any = { runId: "wander-widely", createdAt: 1, observerCount: 0, acknowledged: false, status: { kind: "done", outcome: "completed", completedAt: 2 } };
  f.conversations.push({ conversationId: "young-maple", config: { name: "worker" }, runs: [unrelated] });
  f.notifier.beginTool("child:delegate-boldly", "inspect-target", { action: "inspect", runIds: [f.run.runId] });
  f.notifier.completeTool("child:delegate-boldly", "inspect-target", { content: [], details: { action: "inspect", runs: [{ runId: unrelated.runId, status: "completed" }] } });
  f.fire("session_start"); f.flush();
  assert.deepEqual(f.sent[0].message.details.completions.map((entry: any) => entry.runId), [f.run.runId, unrelated.runId]);
  f.notifier.unsubscribe();
});

test("malformed finalized statuses do not suppress unseen outcomes", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "malformed-inspect", toolName: "subagent", args: { action: "inspect", runIds: [f.run.runId] } });
  f.fire("session_start"); f.flush();
  f.fire("tool_execution_end", { toolCallId: "malformed-inspect", toolName: "subagent", result: { content: [], details: { action: "inspect", runs: [{ runId: f.run.runId }] } } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("inspected skipped outcomes are terminal and stay silent", () => {
  const f = fixture();
  f.run.status = { kind: "done", outcome: "skipped", completedAt: 2, error: "Agent skipped." };
  f.notifier.beginTool("child:delegate-boldly", "inspect-skipped", { action: "inspect", runIds: [f.run.runId] });
  f.fire("session_start"); f.flush();
  f.notifier.completeTool("child:delegate-boldly", "inspect-skipped", { content: [], details: { action: "inspect", runs: [{ runId: f.run.runId, status: "skipped" }] } });
  f.flush();
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("terminal outcomes returned by cancel stay silent when their claims are released", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "cancel-call", toolName: "subagent", args: { action: "cancel", runIds: [f.run.runId] } });
  f.fire("session_start"); f.flush();
  assert.equal(f.sent.length, 0);
  f.fire("tool_execution_end", { toolCallId: "cancel-call", toolName: "subagent", result: { content: [], details: { action: "cancel", runs: [{ runId: f.run.runId, status: "aborted" }] } } });
  f.flush();
  f.fire("turn_end");
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("new completions wait for a grace period before notifying", () => {
  const f = fixture();
  f.run.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();

  f.run.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2, output: "SECRET" };
  f.update("status"); f.flush();
  assert.equal(f.sent.length, 0);
  f.flush(499);
  assert.equal(f.sent.length, 0);
  f.flush(500);
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("terminal inspection during the grace window suppresses delivery", () => {
  const f = fixture();
  f.run.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  f.run.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status");

  f.fire("tool_execution_start", { toolCallId: "inspect-terminal", toolName: "subagent", args: { action: "inspect", runIds: [f.run.runId] } });
  f.fire("tool_execution_end", { toolCallId: "inspect-terminal", toolName: "subagent", result: { content: [], details: { action: "inspect", runs: [{ runId: f.run.runId, status: "completed" }] } } });
  f.flush(500);
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("active inspection remains claimed past grace and becomes eligible when released", () => {
  const f = fixture();
  f.run.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  f.notifier.beginTool("child:delegate-boldly", "inspect-descendant", { action: "inspect", runIds: [f.run.runId] });
  f.run.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status"); f.flush(500);
  assert.equal(f.sent.length, 0);

  f.notifier.completeTool("child:delegate-boldly", "inspect-descendant", { content: [], details: { action: "inspect", runs: [{ runId: f.run.runId, status: "running" }] } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("removal during the grace window drops stale completion delivery", () => {
  const f = fixture();
  f.run.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  f.run.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status");
  f.conversations.length = 0;
  f.flush(500);
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("later completions do not restart the first completion's grace deadline", () => {
  const f = fixture();
  const second: any = { runId: "gather-gently", createdAt: 1, observerCount: 0, acknowledged: false, status: { kind: "running", startedAt: 1 } };
  f.run.status = { kind: "running", startedAt: 1 };
  f.conversations.push({ conversationId: "still-forest", config: { name: "explorer" }, runs: [second] });
  f.fire("session_start"); f.flush();

  f.run.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status", f.run);
  const firstDeadline = f.scheduled.find(item => item.delay === 500 && !item.cancelled)!;
  second.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 3 };
  f.update("status", second);

  assert.equal(firstDeadline.cancelled, false);
  f.notifier.unsubscribe();
});

test("coalesces completions that settle during the same grace window", () => {
  const f = fixture();
  const second: any = { runId: "gather-gently", createdAt: 1, observerCount: 0, acknowledged: false, status: { kind: "running", startedAt: 1 } };
  f.run.status = { kind: "running", startedAt: 1 };
  f.conversations.push({ conversationId: "still-forest", config: { name: "explorer" }, runs: [second] });
  f.fire("session_start"); f.flush();

  f.run.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status", f.run);
  second.status = { kind: "done", outcome: "error", startedAt: 1, completedAt: 3, error: "failed" };
  f.update("status", second);
  f.flush(499);
  assert.equal(f.sent.length, 0);
  f.flush(500);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].message.details.completions.map((entry: any) => entry.runId), [f.run.runId, second.runId]);
  f.notifier.unsubscribe();
});

test("inspecting an active run does not hide its later completion", () => {
  const f = fixture();
  f.run.status = { kind: "running", startedAt: 1 };
  f.fire("tool_execution_start", { toolCallId: "inspect-active", toolName: "subagent", args: { action: "inspect", runIds: [f.run.runId] } });
  f.fire("session_start"); f.flush();
  f.fire("tool_execution_end", { toolCallId: "inspect-active", toolName: "subagent", result: { content: [], details: { action: "inspect", runs: [{ runId: f.run.runId, status: "running" }] } } });
  f.flush();
  assert.equal(f.sent.length, 0);

  f.run.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2, output: "SECRET" };
  f.update("status"); f.flush(500);
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("successful join acknowledgement remains suppressed after its claim is released", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "join-acknowledged", toolName: "subagent", args: { action: "join", runIds: [f.run.runId] } });
  f.fire("session_start");
  f.flush();
  f.run.acknowledged = true;
  f.fire("tool_execution_end", { toolCallId: "join-acknowledged", toolName: "subagent", result: { content: [], details: {} } });
  f.flush();
  f.fire("turn_end");
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("join claim remains active through observer changes until tool execution ends", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "join-observer", toolName: "subagent", args: { action: "join", runIds: [f.run.runId] } });
  f.fire("session_start"); f.flush(); assert.equal(f.sent.length, 0);
  f.run.observerCount = 1; f.update("observer"); f.flush();
  f.run.observerCount = 0; f.update("observer"); f.flush();
  assert.equal(f.sent.length, 0);
  f.fire("tool_execution_end", { toolCallId: "join-observer", toolName: "subagent", result: { content: [], details: {} } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("tool opportunities defer steer notifications until preflight settles", () => {
  const f = fixture("steer", false);
  f.fire("tool_execution_start", { toolName: "bash", args: {} });
  assert.equal(f.sent.length, 0);
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("same-preflight join claims completion before a steer notification is delivered", () => {
  const f = fixture("steer", false);
  f.fire("tool_execution_start", { toolName: "bash", args: {} });
  f.fire("tool_execution_start", { toolCallId: "same-preflight-join", toolName: "subagent", args: { action: "join", runIds: [f.run.runId] } });
  f.flush();
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("active steer send rejection retries with steer opportunity", async () => {
  let attempts = 0;
  const f = fixture("steer", false, () => ++attempts === 1 ? Promise.reject(new Error("closed")) : Promise.resolve());
  f.fire("session_start");
  f.fire("tool_execution_start", { toolName: "other", args: {} });
  f.flush();
  await Promise.resolve(); await Promise.resolve();
  f.flush(500);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map(value => value.options), [{ deliverAs: "steer" }, { deliverAs: "steer" }]);
  f.notifier.unsubscribe();
});
