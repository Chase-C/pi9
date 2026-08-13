import assert from "node:assert/strict";
import { test } from "vitest";
import { CompletionNotifier } from "../../src/notifications.js";

function fixture(mode: "auto" | "steer" | "none" = "auto", idle = true, send?: (message: any, options: any) => void | Promise<void>) {
  let listener: any;
  const handlers = new Map<string, any>();
  const sent: any[] = [];
  const notified: any[] = [];
  const scheduled: Array<{ fn: () => void; delay: number; cancelled: boolean }> = [];
  const generation: any = { generation: 1, initiatedBy: "model", createdAt: 1, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: "completed", completedAt: 2, output: "SECRET" } };
  const conversations: any[] = [{ conversationId: "calm-river", label: "primary task", agent: { name: "worker" }, generations: [generation] }];
  const manager: any = {
    onConversationUpdate(fn: any) { listener = fn; return () => { listener = undefined; }; },
    listConversations: () => conversations,
    conversation: (id: string) => conversations.find(value => value.conversationId === id),
    generationSnapshot: (ref: { conversationId: string; generation: number }) => conversations
      .find(value => value.conversationId === ref.conversationId)?.generations
      .find((value: any) => value.generation === ref.generation),
    isModelSubscribed: (ref: { conversationId: string; generation: number }) => {
      const value = conversations.find(item => item.conversationId === ref.conversationId)?.generations
        .find((item: any) => item.generation === ref.generation);
      return value?.modelSubscribed ?? value?.initiatedBy !== "user";
    },
    projectSubagent: (id: string) => {
      const conversation = conversations.find(value => value.conversationId === id);
      const latest = conversation.generations.at(-1);
      const status = latest.status.outcome === "completed" ? "completed"
        : latest.status.outcome === "aborted" ? "cancelled" : "failed";
      return {
        ok: true,
        subagentId: id,
        label: conversation.label ?? conversation.agent.name,
        agent: conversation.agent.name,
        generation: latest.generation,
        initiatedBy: latest.initiatedBy ?? "model",
        status,
        collected: latest.receipts.model,
        actionHints: ["inspect", "join", "remove"],
        ...(status === "failed" ? { failure: `Subagent failed: ${latest.status.error ?? "unknown error"}` } : {}),
      };
    },
  };
  const pi: any = {
    on(event: string, fn: any) { handlers.set(event, fn); },
    sendMessage(message: any, options: any) { sent.push({ message, options }); return send?.(message, options); },
  };
  const notifier = new CompletionNotifier({ pi, manager, getMode: () => mode, scheduleRetry: (fn, delay) => { const item = { fn, delay, cancelled: false }; scheduled.push(item); return () => { item.cancelled = true; }; } });
  return { generation, conversations, sent, notified, scheduled, notifier, flush(maxDelay = 0) { for (;;) { const index = scheduled.findIndex(item => item.delay <= maxDelay); if (index < 0) break; const item = scheduled.splice(index, 1)[0]; if (!item.cancelled) item.fn(); } }, fire(event: string, value: unknown = {}) { handlers.get(event)?.(value, { isIdle: () => idle, hasUI: true, ui: { notify: (message: string, level: string) => notified.push({ message, level }) } }); }, update(kind: string, updatedGeneration: any = generation) { const conversation = conversations.find(value => value.generations.includes(updatedGeneration)); listener?.({ conversationId: conversation?.conversationId, snapshot: () => ({ generations: [updatedGeneration] }) }, kind); } };
}

test("notifies a terminal generation once without leaking output", () => {
  const f = fixture();
  f.fire("session_start"); f.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.display, false);
  assert.deepEqual(f.notified, [{ message: "1 subagent finished: worker (primary task) · completed", level: "info" }]);
  assert.doesNotMatch(JSON.stringify(f.sent[0]), /SECRET/);
  f.fire("turn_end");
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("user-started completion notifies the UI and queues awareness without waking the model", () => {
  const f = fixture();
  f.generation.initiatedBy = "user";
  f.fire("session_start"); f.flush();

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.customType, "subagent-activity");
  assert.deepEqual(f.sent[0].options, { deliverAs: "nextTurn" });
  assert.match(f.sent[0].message.content, /initiatedBy="user"/);
  assert.match(f.sent[0].message.content, /collected="false"/);
  assert.deepEqual(f.notified, [{ message: "1 subagent finished: worker (primary task) · completed", level: "info" }]);
  f.notifier.unsubscribe();
});

test("automatic user collection before awareness delivery suppresses only the human notification", () => {
  const f = fixture();
  f.generation.initiatedBy = "user";
  f.generation.receipts.user = true;
  f.fire("session_start"); f.flush();

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.customType, "subagent-activity");
  assert.match(f.sent[0].message.content, /collected="false"/);
  assert.equal(f.sent[0].message.details.activities[0].collected, false);
  assert.equal(f.notified.length, 0);
  f.notifier.unsubscribe();
});

test("automatic user collection after awareness delivery does not erase shared-workspace awareness", () => {
  const f = fixture();
  f.generation.initiatedBy = "user";
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", ...f.sent[0].message };

  f.generation.receipts.user = true;
  f.update("collection"); f.flush();
  const reconciled: any[] = f.notifier.reconcileMessages([queued] as never);

  assert.equal(reconciled.length, 1);
  assert.match(reconciled[0].content, /collected="false"/);
  assert.equal(reconciled[0].details.activities[0].collected, false);
  assert.equal(f.notified.length, 1);
  f.notifier.unsubscribe();
});

test("user activity reconciles to current status and coalesces active and finished notices", () => {
  const f = fixture();
  f.generation.initiatedBy = "user";
  f.generation.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  const active = { role: "custom", ...f.sent[0].message };

  f.generation.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status"); f.flush(500);
  const finished = { role: "custom", ...f.sent[1].message };
  const reconciled: any[] = f.notifier.reconcileMessages([active, finished] as never);

  assert.equal(reconciled.length, 1);
  assert.match(reconciled[0].content, /status="completed"/);
  assert.equal(f.notified.length, 1);
  f.notifier.unsubscribe();
});

test("queued user activity disappears after the model subscribes", () => {
  const f = fixture();
  f.generation.initiatedBy = "user";
  f.generation.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", ...f.sent[0].message };

  f.generation.modelSubscribed = true;
  assert.deepEqual(f.notifier.reconcileMessages([queued] as never), []);
  f.notifier.unsubscribe();
});

test("model subscription replaces queued finished user activity with model completion", () => {
  const f = fixture();
  f.generation.initiatedBy = "user";
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", ...f.sent[0].message };

  f.generation.modelSubscribed = true;
  f.fire("turn_end"); f.flush();

  assert.deepEqual(f.notifier.reconcileMessages([queued] as never), []);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].message.customType, "subagent-completion");
  f.notifier.unsubscribe();
});

test("subscribed user-started work reports completion to the model without an activity notice", () => {
  const f = fixture();
  f.generation.initiatedBy = "user";
  f.generation.modelSubscribed = true;
  f.fire("session_start"); f.flush();

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.customType, "subagent-completion");
  assert.deepEqual(f.sent[0].options, { triggerTurn: true });
  assert.equal(f.notified.length, 1);
  f.notifier.unsubscribe();
});

test("user receipt does not suppress model completion for a subscribed generation", () => {
  const f = fixture();
  f.generation.receipts.user = true;
  f.fire("session_start"); f.flush();

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.customType, "subagent-completion");
  assert.equal(f.sent[0].message.details.completions[0].collected, false);
  assert.equal(f.notified.length, 0);
  f.notifier.unsubscribe();
});

test("model receipt does not suppress the human UI notification", () => {
  const f = fixture();
  f.generation.receipts.model = true;
  f.fire("session_start"); f.flush();

  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.notified, [{ message: "1 subagent finished: worker (primary task) · completed", level: "info" }]);
  f.notifier.unsubscribe();
});

test("automatic user collection after model delivery does not reconcile away its completion", () => {
  const f = fixture();
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", ...f.sent[0].message };

  f.generation.receipts.user = true;
  f.update("collection"); f.flush();

  assert.equal(f.notifier.reconcileMessages([queued] as never).length, 1);
  assert.equal(f.notified.length, 1);
  f.notifier.unsubscribe();
});

test("context reconciliation removes a queued completion observed before model delivery", () => {
  const f = fixture();
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", customType: "subagent-completion", ...f.sent[0].message };

  f.notifier.beginTool("root", "inspect-after-enqueue", { action: "inspect", subagentIds: ["calm-river"] });
  f.notifier.completeTool("root", "inspect-after-enqueue", {
    content: [],
    details: {
      response: { action: "inspect", results: [{ subagentId: "calm-river", status: "completed" }] },
      observedGenerations: [{ conversationId: "calm-river", generation: 1 }],
    },
  });

  assert.deepEqual(f.notifier.reconcileMessages([queued] as never), []);
  f.notifier.unsubscribe();
});

test("context reconciliation rebuilds a completion batch from still-unobserved generations", () => {
  const f = fixture();
  const second: any = { generation: 1, createdAt: 1, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: "error", completedAt: 3 } };
  f.conversations.push({ conversationId: "still-forest", agent: { name: "explorer" }, label: "second <task>", generations: [second] });
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", customType: "subagent-completion", ...f.sent[0].message };

  f.notifier.beginTool("root", "inspect-first", { action: "inspect", subagentIds: ["calm-river"] });
  f.notifier.completeTool("root", "inspect-first", {
    content: [],
    details: {
      response: { action: "inspect", results: [{ subagentId: "calm-river", status: "completed" }] },
      observedGenerations: [{ conversationId: "calm-river", generation: 1 }],
    },
  });

  const reconciled: any[] = f.notifier.reconcileMessages([queued] as never);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].content, [
    "<subagent-notification>",
    '  <subagent subagentId="still-forest" generation="1" initiatedBy="model" status="failed" agent="explorer" label="second &lt;task&gt;" collected="false" actionHints="inspect,join,remove" failure="Subagent failed: unknown error"/>',
    "</subagent-notification>",
  ].join("\n"));
  assert.deepEqual(reconciled[0].details.completions.map((entry: any) => entry.subagentId), ["still-forest"]);
  assert.deepEqual(queued.details.completions.map((entry: any) => entry.subagentId), ["calm-river", "still-forest"]);
  assert.match(queued.content, /subagentId="calm-river"/);
  f.notifier.unsubscribe();
});

test("context reconciliation omits queued completions collected for the model before delivery", () => {
  const f = fixture();
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", customType: "subagent-completion", ...f.sent[0].message };
  f.generation.receipts.model = true;

  assert.deepEqual(f.notifier.reconcileMessages([queued] as never), []);
  f.notifier.unsubscribe();
});

test("context reconciliation temporarily hides a completion with an active collection binding", () => {
  const f = fixture();
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", customType: "subagent-completion", ...f.sent[0].message };

  f.generation.activeCollectionCount = 1;
  assert.deepEqual(f.notifier.reconcileMessages([queued] as never), []);

  f.generation.activeCollectionCount = 0;
  assert.equal(f.notifier.reconcileMessages([queued] as never).length, 1);
  f.notifier.unsubscribe();
});

test("active collection binding temporarily suppresses completion delivery", () => {
  const f = fixture();
  f.generation.activeCollectionCount = 1;
  f.fire("session_start"); f.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.notified.length, 0);

  f.generation.activeCollectionCount = 0;
  f.update("activeCollection"); f.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.notified.length, 1);
  f.notifier.unsubscribe();
});

test("context reconciliation hides a completion while a lifecycle tool claims it", () => {
  const f = fixture();
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", customType: "subagent-completion", ...f.sent[0].message };

  f.notifier.beginTool("root", "inspect-in-flight", { action: "inspect", subagentIds: ["calm-river"] });
  assert.deepEqual(f.notifier.reconcileMessages([queued] as never), []);
  f.notifier.unsubscribe();
});

test("model-collected descendants stay silent while detached descendants remain eligible", () => {
  const f = fixture();
  f.generation.receipts.model = true;
  const detached: any = { generation: 1, createdAt: 1, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: "completed", completedAt: 2 } };
  f.conversations.push({ conversationId: "young-maple", agent: { name: "worker" }, generations: [detached] });
  f.fire("session_start"); f.flush();
  assert.deepEqual(f.sent[0].message.details.completions.map((entry: any) => entry.subagentId), ["young-maple"]);
  f.notifier.unsubscribe();
});

test("reconciliation resolves the latest execution for a resumed subagent", () => {
  const f = fixture();
  f.generation.receipts.model = true;
  const resumed: any = { generation: 2, createdAt: 3, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: "completed", completedAt: 4 } };
  f.conversations[0].generations.push(resumed);
  f.fire("session_start"); f.flush();
  const queued = { role: "custom", customType: "subagent-completion", ...f.sent[0].message };

  assert.equal(f.notifier.reconcileMessages([queued] as never).length, 1);
  f.notifier.unsubscribe();
});

test("completion messages do not rebound after runtime-local identities are reused", () => {
  const previous = fixture();
  previous.fire("session_start"); previous.flush();
  const stored = { role: "custom", customType: "subagent-completion", ...previous.sent[0].message };
  previous.notifier.unsubscribe();

  const replacement = fixture();
  assert.deepEqual(replacement.notifier.reconcileMessages([stored] as never), []);
  replacement.notifier.unsubscribe();
});

test("successive generations retain exact completion correlation", () => {
  const f = fixture();
  f.notifier.beginTool("root", "inspect-first-generation", { action: "inspect", subagentIds: ["calm-river"] });
  f.generation.receipts.model = true;
  f.conversations[0].generations.push({ generation: 2, createdAt: 3, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: "completed", completedAt: 4 } });
  f.notifier.completeTool("root", "inspect-first-generation", {
    details: { response: { results: [{ subagentId: "calm-river", status: "completed" }] } },
  });
  f.fire("session_start"); f.flush();

  assert.deepEqual(f.sent[0].message.details.completions.map((entry: any) => entry.generation), [2]);
  f.notifier.unsubscribe();
});

for (const action of ["inspect", "cancel"] as const) {
  test(`${action} completion uses the generation acted on after rollover and releases the initial claim`, () => {
    const f = fixture();
    const toolCallId = `${action}-after-rollover`;
    f.notifier.beginTool("root", toolCallId, { action, subagentIds: ["calm-river"] });
    f.generation.receipts.model = true;
    const resumed: any = { generation: 2, createdAt: 3, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: action === "cancel" ? "aborted" : "completed", completedAt: 4 } };
    f.conversations[0].generations.push(resumed);

    f.notifier.completeTool("root", toolCallId, {
      details: {
        response: { action, results: [{ subagentId: "calm-river", status: action === "cancel" ? "cancelled" : "completed" }] },
        observedGenerations: [{ conversationId: "calm-river", generation: 2 }],
      },
    });
    f.fire("session_start"); f.flush();
    assert.equal(f.sent.length, 0);

    resumed.receipts.model = true;
    f.conversations[0].generations.push({ generation: 3, createdAt: 5, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: "completed", completedAt: 6 } });
    f.fire("turn_end"); f.flush();
    assert.deepEqual(f.sent[0].message.details.completions.map((entry: any) => entry.generation), [3]);
    f.notifier.unsubscribe();
  });
}

test("old completion messages do not rebound to a later execution", () => {
  const f = fixture();
  f.fire("session_start"); f.flush();
  const old = { role: "custom", customType: "subagent-completion", ...f.sent[0].message };
  f.generation.receipts.model = true;
  f.conversations[0].generations.push({ generation: 2, createdAt: 3, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: "completed", completedAt: 4 } });

  assert.deepEqual(f.notifier.reconcileMessages([old] as never), []);
  f.notifier.unsubscribe();
});

test("old completion messages do not rebound when resumed generations share a completion timestamp", () => {
  const f = fixture();
  f.fire("session_start"); f.flush();
  const old = { role: "custom", customType: "subagent-completion", ...f.sent[0].message };
  f.generation.receipts.model = true;
  f.conversations[0].generations.push({ generation: 2, createdAt: 3, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: "completed", completedAt: 2 } });

  assert.deepEqual(f.notifier.reconcileMessages([old] as never), []);
  f.notifier.unsubscribe();
});

test("none mode and model-collected generations are ineligible for completion delivery", () => {
  const none = fixture("none"); none.fire("session_start"); none.flush(); assert.equal(none.sent.length, 0); none.notifier.unsubscribe();
  const collected = fixture(); collected.generation.receipts.model = true; collected.fire("session_start"); collected.flush(); assert.equal(collected.sent.length, 0); collected.notifier.unsubscribe();
});

test("none mode still queues user-started activity for the next natural turn", () => {
  const f = fixture("none");
  f.generation.initiatedBy = "user";
  f.fire("session_start"); f.flush();

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.customType, "subagent-activity");
  assert.deepEqual(f.sent[0].options, { deliverAs: "nextTurn" });
  assert.equal(f.notified.length, 0);
  f.notifier.unsubscribe();
});

test("none mode preserves retries after synchronous user-activity delivery failure", () => {
  let attempts = 0;
  const f = fixture("none", true, () => {
    if (++attempts === 1) throw new Error("closed");
  });
  f.generation.initiatedBy = "user";
  f.fire("session_start"); f.flush();
  assert.equal(f.sent.length, 1);

  f.flush(500);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].message.customType, "subagent-activity");
  assert.deepEqual(f.sent[1].options, { deliverAs: "nextTurn" });
  f.notifier.unsubscribe();
});

test("tool execution end releases claims when execution was rejected before the tool ran", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "blocked-call", toolName: "subagent", args: { action: "inspect", subagentIds: ["calm-river"] } });
  f.fire("session_start"); f.flush();
  assert.equal(f.sent.length, 0);
  f.fire("tool_execution_end", { toolCallId: "blocked-call", toolName: "subagent", isError: true, result: { content: [], details: {} } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("overlapping tool calls retain independent claims on the same generation", () => {
  const f = fixture();
  for (const toolCallId of ["inspect-one", "inspect-two"]) {
    f.fire("tool_execution_start", { toolCallId, toolName: "subagent", args: { action: "inspect", subagentIds: ["calm-river"] } });
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
  f.fire("tool_execution_start", { toolCallId: "join-call", toolName: "subagent", args: { action: "join", subagentIds: ["calm-river"] } });
  f.fire("session_start"); f.flush(250); assert.equal(f.sent.length, 0);
  f.fire("tool_execution_end", { toolCallId: "join-call", toolName: "subagent", result: { content: [], details: {} } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("recursive cancel holds its descendant claim through grace and marks the outcome observed", () => {
  const f = fixture();
  f.generation.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  f.notifier.beginTool("child:parent-agent:1", "cancel-descendant", { action: "cancel", subagentIds: ["calm-river"] });
  f.generation.status = { kind: "done", outcome: "aborted", startedAt: 1, completedAt: 2, error: "Generation cancelled." };
  f.update("status"); f.flush(500);
  assert.equal(f.sent.length, 0);

  f.notifier.completeTool("child:parent-agent:1", "cancel-descendant", { content: [], details: {
    response: { action: "cancel", results: [{ subagentId: "calm-river", status: "cancelled" }] },
    observedGenerations: [{ conversationId: "calm-river", generation: 1 }],
  } });
  f.flush();
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("finalized results cannot mark unclaimed generations observed", () => {
  const f = fixture();
  const unrelated: any = { generation: 1, createdAt: 1, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "done", outcome: "completed", completedAt: 2 } };
  f.conversations.push({ conversationId: "young-maple", agent: { name: "worker" }, generations: [unrelated] });
  f.notifier.beginTool("child:parent-agent:1", "inspect-target", { action: "inspect", subagentIds: ["calm-river"] });
  f.notifier.completeTool("child:parent-agent:1", "inspect-target", { content: [], details: {
    response: { action: "inspect", results: [{ subagentId: "young-maple", status: "completed" }] },
    observedGenerations: [{ conversationId: "young-maple", generation: 1 }],
  } });
  f.fire("session_start"); f.flush();
  assert.deepEqual(f.sent[0].message.details.completions.map((entry: any) => entry.subagentId), ["calm-river", "young-maple"]);
  f.notifier.unsubscribe();
});

test("malformed exact generation details do not suppress unseen outcomes", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "malformed-inspect", toolName: "subagent", args: { action: "inspect", subagentIds: ["calm-river"] } });
  f.fire("session_start"); f.flush();
  f.fire("tool_execution_end", { toolCallId: "malformed-inspect", toolName: "subagent", result: { content: [], details: {
    response: { action: "inspect", results: [{ subagentId: "calm-river", status: "completed" }] },
    observedGenerations: [{ conversationId: "calm-river", generation: "1" }],
  } } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("inspected skipped outcomes are terminal and stay silent", () => {
  const f = fixture();
  f.generation.status = { kind: "done", outcome: "skipped", completedAt: 2, error: "Agent skipped." };
  f.notifier.beginTool("child:parent-agent:1", "inspect-skipped", { action: "inspect", subagentIds: ["calm-river"] });
  f.fire("session_start"); f.flush();
  f.notifier.completeTool("child:parent-agent:1", "inspect-skipped", { content: [], details: {
    response: { action: "inspect", results: [{ subagentId: "calm-river", status: "failed" }] },
    observedGenerations: [{ conversationId: "calm-river", generation: 1 }],
  } });
  f.flush();
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("terminal outcomes returned by cancel stay silent when their claims are released", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "cancel-call", toolName: "subagent", args: { action: "cancel", subagentIds: ["calm-river"] } });
  f.fire("session_start"); f.flush();
  assert.equal(f.sent.length, 0);
  f.fire("tool_execution_end", { toolCallId: "cancel-call", toolName: "subagent", result: { content: [], details: {
    response: { action: "cancel", results: [{ subagentId: "calm-river", status: "cancelled" }] },
    observedGenerations: [{ conversationId: "calm-river", generation: 1 }],
  } } });
  f.flush();
  f.fire("turn_end");
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("new completions wait for a grace period before notifying", () => {
  const f = fixture();
  f.generation.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();

  f.generation.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2, output: "SECRET" };
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
  f.generation.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  f.generation.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status");

  f.fire("tool_execution_start", { toolCallId: "inspect-terminal", toolName: "subagent", args: { action: "inspect", subagentIds: ["calm-river"] } });
  f.fire("tool_execution_end", { toolCallId: "inspect-terminal", toolName: "subagent", result: { content: [], details: {
    response: { action: "inspect", results: [{ subagentId: "calm-river", status: "completed" }] },
    observedGenerations: [{ conversationId: "calm-river", generation: 1 }],
  } } });
  f.flush(500);
  assert.equal(f.sent.length, 0);
  assert.equal(f.notified.length, 1);
  assert.deepEqual(f.generation.receipts, { user: false, model: false });
  f.notifier.unsubscribe();
});

test("active inspection remains claimed past grace and becomes eligible when released", () => {
  const f = fixture();
  f.generation.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  f.notifier.beginTool("child:parent-agent:1", "inspect-descendant", { action: "inspect", subagentIds: ["calm-river"] });
  f.generation.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status"); f.flush(500);
  assert.equal(f.sent.length, 0);

  f.notifier.completeTool("child:parent-agent:1", "inspect-descendant", { content: [], details: { response: { action: "inspect", results: [{ subagentId: "calm-river", status: "running" }] } } });
  f.flush();
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("removal during the grace window drops stale completion delivery", () => {
  const f = fixture();
  f.generation.status = { kind: "running", startedAt: 1 };
  f.fire("session_start"); f.flush();
  f.generation.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status");
  f.conversations.length = 0;
  f.flush(500);
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("later completions do not restart the first completion's grace deadline", () => {
  const f = fixture();
  const second: any = { generation: 1, createdAt: 1, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "running", startedAt: 1 } };
  f.generation.status = { kind: "running", startedAt: 1 };
  f.conversations.push({ conversationId: "still-forest", agent: { name: "explorer" }, generations: [second] });
  f.fire("session_start"); f.flush();

  f.generation.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status", f.generation);
  const firstDeadline = f.scheduled.find(item => item.delay === 500 && !item.cancelled)!;
  second.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 3 };
  f.update("status", second);

  assert.equal(firstDeadline.cancelled, false);
  f.notifier.unsubscribe();
});

test("coalesces completions that settle during the same grace window", () => {
  const f = fixture();
  const second: any = { generation: 1, createdAt: 1, activeCollectionCount: 0, receipts: { user: false, model: false }, status: { kind: "running", startedAt: 1 } };
  f.generation.status = { kind: "running", startedAt: 1 };
  f.conversations.push({ conversationId: "still-forest", agent: { name: "explorer" }, generations: [second] });
  f.fire("session_start"); f.flush();

  f.generation.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2 };
  f.update("status", f.generation);
  second.status = { kind: "done", outcome: "error", startedAt: 1, completedAt: 3, error: "failed" };
  f.update("status", second);
  f.flush(499);
  assert.equal(f.sent.length, 0);
  f.flush(500);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].message.details.completions.map((entry: any) => entry.subagentId), ["calm-river", "still-forest"]);
  f.notifier.unsubscribe();
});

test("inspecting an active generation does not hide its later completion", () => {
  const f = fixture();
  f.generation.status = { kind: "running", startedAt: 1 };
  f.fire("tool_execution_start", { toolCallId: "inspect-active", toolName: "subagent", args: { action: "inspect", subagentIds: ["calm-river"] } });
  f.fire("session_start"); f.flush();
  f.fire("tool_execution_end", { toolCallId: "inspect-active", toolName: "subagent", result: { content: [], details: { response: { action: "inspect", results: [{ subagentId: "calm-river", status: "running" }] } } } });
  f.flush();
  assert.equal(f.sent.length, 0);

  f.generation.status = { kind: "done", outcome: "completed", startedAt: 1, completedAt: 2, output: "SECRET" };
  f.update("status"); f.flush(500);
  assert.equal(f.sent.length, 1);
  f.notifier.unsubscribe();
});

test("successful model collection remains suppressed after its claim is released", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "join-collected", toolName: "subagent", args: { action: "join", subagentIds: ["calm-river"] } });
  f.fire("session_start");
  f.flush();
  f.generation.receipts.model = true;
  f.fire("tool_execution_end", { toolCallId: "join-collected", toolName: "subagent", result: { content: [], details: {} } });
  f.flush();
  f.fire("turn_end");
  assert.equal(f.sent.length, 0);
  assert.equal(f.notified.length, 1);
  f.notifier.unsubscribe();
});

test("join claim remains active through collection binding changes until tool execution ends", () => {
  const f = fixture();
  f.fire("tool_execution_start", { toolCallId: "join-observer", toolName: "subagent", args: { action: "join", subagentIds: ["calm-river"] } });
  f.fire("session_start"); f.flush(); assert.equal(f.sent.length, 0);
  f.generation.activeCollectionCount = 1; f.update("activeCollection"); f.flush();
  f.generation.activeCollectionCount = 0; f.update("activeCollection"); f.flush();
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
  f.fire("tool_execution_start", { toolCallId: "same-preflight-join", toolName: "subagent", args: { action: "join", subagentIds: ["calm-river"] } });
  f.flush();
  assert.equal(f.sent.length, 0);
  f.notifier.unsubscribe();
});

test("synchronous model delivery failure retries independently of the UI notification", () => {
  let attempts = 0;
  const f = fixture("auto", true, () => {
    if (++attempts === 1) throw new Error("closed");
  });
  f.fire("session_start");
  f.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.notified.length, 1);

  f.flush(500);
  assert.equal(f.sent.length, 2);
  assert.equal(f.notified.length, 1);
  f.notifier.unsubscribe();
});

test("active steer send rejection retries without duplicating the UI notification", async () => {
  let attempts = 0;
  const f = fixture("steer", false, () => ++attempts === 1 ? Promise.reject(new Error("closed")) : Promise.resolve());
  f.fire("session_start");
  f.fire("tool_execution_start", { toolName: "other", args: {} });
  f.flush();
  await Promise.resolve(); await Promise.resolve();
  f.flush(500);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map(value => value.options), [{ deliverAs: "steer" }, { deliverAs: "steer" }]);
  assert.equal(f.notified.length, 1);
  f.notifier.unsubscribe();
});
