import { test } from "vitest";
import assert from "node:assert/strict";
import { joinAction, listAction, removeAction, runAction } from "../../src/tool/actions.js";

const cid = "amber-acorn" as any, rid = "adapt-ably" as any;
const settings = () => ({ display: {} }) as any;
const snapshot = (status: any = { kind: "running", startedAt: 1 }) => ({ conversationId: cid, createdAt: 1, config: { name: "helper" }, runs: [{ runId: rid, kind: "spawn", prompt: "x", createdAt: 1, status, activity: { turns: 0, compactions: 0, toolHistory: [] }, usage: undefined, observerCount: 1, acknowledged: false, notification: "none" }], currentRun: undefined, capabilities: { canResume: false, canRemove: true } });
const deps = (manager: any) => ({ agentManager: manager, agentRegistry: { agents: new Map(), summarizeAgent: () => "" }, getCurrentSettings: settings }) as any;
const json = (r: any) => JSON.parse(r.content[0].text);

test("run returns ordered starts immediately and does not wait for child work", () => {
  let resolve!: () => void; const pending = new Promise<void>(r => { resolve = r; });
  const starts = [{ ok: true, inputIndex: 0, conversationId: cid, runId: rid }, { ok: false, inputIndex: 1, error: "Unknown agent" }];
  const manager = { startRun: (_ctx: any, tasks: any[]) => { assert.equal(tasks.length, 2); return { starts, completion: pending }; } };
  const result = runAction(deps(manager), { action: "run", tasks: [{ kind: "spawn", agent: "helper", prompt: "x" }, { kind: "spawn", agent: "missing", prompt: "x" }] }, {} as any);
  assert.deepEqual(json(result), starts); assert.equal(result.isError, false); resolve();
});

test("list is output-free flat recoverable run inventory and filtering is pure", () => {
  let calls = 0; const manager = { listConversations: () => { calls++; return [snapshot(), snapshot({ kind: "done", outcome: "completed", completedAt: 2 })]; } };
  const result = listAction(deps(manager), { action: "list", status: ["completed"] });
  assert.equal(calls, 1); assert.deepEqual(json(result).map((x: any) => [x.conversationId, x.runId, x.status]), [[cid, rid, "completed"]]);
});

test("remove forwards only the explicit conversation batch", () => {
  let received: any; const summary = { removed: 1, aborted: 0, conversationIds: [cid], errors: [] };
  const result = removeAction(deps({ removeConversations: (ids: any) => { received = ids; return summary; } }), { action: "remove", conversationIds: [cid] });
  assert.deepEqual(received, [cid]); assert.deepEqual(json(result), summary);
});

test("join validates atomically through manager and child errors are successful tool results", async () => {
  let released = 0, acknowledged: any; const updates: any[] = [];
  const manager = { bindJoin: (ids: any) => { assert.deepEqual(ids, [rid]); return { completion: Promise.resolve([{ status: "error", error: "child failed" }]), release: () => released++ }; }, listConversations: () => [snapshot()], onAgentUpdate: () => () => {}, acknowledgeRuns: (ids: any) => { acknowledged = ids; }, runner: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() } };
  const result = await joinAction(deps(manager), { action: "join", runIds: [rid] }, undefined, update => updates.push(update));
  assert.equal(result.isError, false); assert.deepEqual(json(result), [{ runId: rid, status: "error", error: "child failed" }]); assert.equal(released, 1); assert.deepEqual(acknowledged, [rid]); assert.ok(updates.length >= 1);
});

test("join streams updates and preserves exact requested order", async () => {
  const rid2 = "assemble-abruptly" as any; let listener: any;
  const manager = { bindJoin: () => ({ completion: Promise.resolve([{ status: "completed", output: "one" }, { status: "completed", output: "two" }]), release() {} }), listConversations: () => [snapshot()], onAgentUpdate: (fn: any) => { listener = fn; return () => {}; }, acknowledgeRuns() {}, runner: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() } };
  const updates: any[] = []; const promise = joinAction(deps(manager), { action: "join", runIds: [rid, rid2] }, undefined, u => updates.push(u)); listener();
  assert.deepEqual(json(await promise).map((x: any) => x.runId), [rid, rid2]); assert.ok(updates.length >= 2);
});

test("caller cancellation releases join observer without cancelling child work", async () => {
  const controller = new AbortController(); let released = 0; let childCancelled = false;
  const manager = { bindJoin: () => ({ completion: new Promise(() => {}), release: () => released++, cancel: () => { childCancelled = true; } }), listConversations: () => [], onAgentUpdate: () => () => {}, runner: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() } };
  const promise = joinAction(deps(manager), { action: "join", runIds: [rid] }, controller.signal, undefined); controller.abort(); const result = await promise;
  assert.equal(result.isError, true); assert.equal(released, 1); assert.equal(childCancelled, false);
});

test("child join suspends the parent queue slot", async () => {
  let suspended: any; const manager = { bindJoin: () => ({ completion: Promise.resolve([{ status: "completed" }]), release() {} }), listConversations: () => [], onAgentUpdate: () => () => {}, runner: { suspendAgentSlotDuring: async (id: any, fn: any) => { suspended = id; return fn(); } } };
  await joinAction({ ...deps(manager), parentConversationId: cid }, { action: "join", runIds: [rid] }, undefined, undefined); assert.equal(suspended, cid);
});

test("a bound join acknowledges its aborted outcome after concurrent removal", async () => {
  let resolve!: (value: any[]) => void; let acknowledged = 0;
  const binding: any = {
    completion: new Promise<any[]>(r => { resolve = r; }),
    project: () => [{ conversationId: cid, runId: rid, status: { kind: "done", outcome: "aborted", completedAt: 2, error: "Conversation removed." } }],
    acknowledge: () => { acknowledged++; }, release() {},
  };
  const manager: any = { bindJoin: () => binding, onAgentUpdate: () => () => {}, runner: { suspendAgentSlotDuring: async (_id: any, fn: any) => fn() }, acknowledgeRuns: () => { throw new Error("mutable lookup was used"); } };
  const pending = joinAction(deps(manager), { action: "join", runIds: [rid] }, undefined, undefined);
  resolve([{ status: "aborted", error: "Conversation removed." }]);
  assert.deepEqual(json(await pending), [{ conversationId: cid, runId: rid, status: "aborted", error: "Conversation removed." }]);
  assert.equal(acknowledged, 1);
});

test("whole-batch bind errors become invocation errors without acquiring updates", async () => {
  let subscribed = false; const manager = { bindJoin: () => { throw new Error("Unknown or removed run"); }, onAgentUpdate: () => { subscribed = true; return () => {}; } };
  const result = await joinAction(deps(manager), { action: "join", runIds: [rid] }, undefined, undefined); assert.equal(result.isError, true); assert.match(result.content[0].text, /Unknown/); assert.equal(subscribed, false);
});
