import { test, expect } from "vitest";
import { SubagentRuntime } from "../../src/runtime.js";
import { registerSubagentLifecycleEvents } from "../../src/index.js";
import { Conversation, completedRun } from "../../src/conversation.js";
import type { ConversationId, RunId } from "../../src/identifiers.js";

const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
const registry = { agents: new Map([["worker", config]]) } as any;

test("spawn publishes queued after manager conversation and run indexes exist", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const manager = new SubagentRuntime(registry, 1, (async () => { await gate; return { status: "completed" }; }) as any);
  const emitted: Array<{ event: string; data: any }> = [];
  const unsubscribe = registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, manager);
  const started = manager.startRun({ cwd: "/tmp" } as any, [{ kind: "spawn", agent: "worker", prompt: "work" }] as any);
  const identity = started.starts[0] as any;
  const queued = emitted.find(value => value.event === "subagent:queued")!;
  expect(queued.data).toMatchObject({ ok: true, subagentId: identity.conversationId, status: "queued" });
  expect(manager.conversation(identity.conversationId).runs.some(run => run.runId === identity.runId)).toBe(true);
  expect(() => manager.bindSubagentJoin([identity.conversationId])).not.toThrow();
  release(); await started.completion; unsubscribe();
});

test("finished events use the root-relative canonical block", async () => {
  const manager = new SubagentRuntime(registry, 1, async (_ctx, agent, run) => {
    agent.bindSession({ messages: [], subscribe: () => () => {}, abort() {} } as any);
    return completedRun(agent, run.runId, "done");
  });
  const emitted: Array<{ event: string; data: any }> = [];
  const unsubscribe = registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, manager);
  const started = manager.startRun({ cwd: "/tmp" } as any, [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }] as any);
  await started.completion;

  const finished = emitted.find(value => value.event === "subagent:finished")!;
  expect(finished.data).toMatchObject({
    ok: true,
    subagentId: (started.starts[0] as any).conversationId,
    label: "work",
    agent: "worker",
    status: "completed",
    joined: false,
    availableActions: ["inspect", "join", "remove"],
  });
  expect(emitted.map(value => value.event)).toEqual(["subagent:queued", "subagent:started", "subagent:finished"]);
  unsubscribe();
});

test("non-status changes do not publish public lifecycle events", () => {
  const conversationId = "calm-otter" as ConversationId;
  const ownerRunId = "build-boldly" as RunId;
  let listener: ((agent: Conversation, kind: any) => void) | undefined;
  const source = {
    onConversationUpdate: (next: typeof listener) => { listener = next; return () => {}; },
    projectSubagent: () => ({ ok: true as const, subagentId: conversationId, label: "delegate", agent: "worker", status: "running" as const, availableActions: [] }),
  };
  const emitted: Array<{ event: string; data: any }> = [];
  registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, source);
  const agent = new Conversation(
    conversationId,
    ownerRunId,
    config,
    { kind: "spawn", agent: "worker", prompt: "delegate", label: "delegate" },
    (changed, kind) => listener?.(changed, kind),
  );
  emitted.length = 0;

  const index = agent.beginNestedJoin(ownerRunId, ["search-boldly" as RunId], "nested-call");
  agent.updateNestedJoin(ownerRunId, index, { state: "interrupted", error: "cancelled" });

  expect(emitted).toEqual([]);
});
