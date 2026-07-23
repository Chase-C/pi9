import { test, expect } from "vitest";
import { SubagentRuntime } from "../../src/runtime.js";
import { registerSubagentLifecycleEvents } from "../../src/index.js";
import { Conversation } from "../../src/conversation.js";
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
  expect(queued.data).toMatchObject({ conversationId: identity.conversationId, runId: identity.runId });
  expect(manager.conversation(identity.conversationId).runs.some(run => run.runId === identity.runId)).toBe(true);
  expect(() => manager.bindJoin([identity.runId])).not.toThrow();
  release(); await started.completion; unsubscribe();
});

test("nested join changes publish owner updates without extra lifecycle milestones", () => {
  const conversationId = "calm-otter" as ConversationId;
  const ownerRunId = "build-boldly" as RunId;
  let listener: ((agent: Conversation, kind: any) => void) | undefined;
  const source = { onConversationUpdate: (next: typeof listener) => { listener = next; return () => {}; } };
  const emitted: Array<{ event: string; data: any }> = [];
  registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, source);
  const agent = new Conversation(
    conversationId,
    ownerRunId,
    config,
    { kind: "spawn", agent: "worker", prompt: "delegate" },
    (changed, kind) => listener?.(changed, kind),
  );
  emitted.length = 0;

  const index = agent.beginNestedJoin(ownerRunId, ["search-boldly" as RunId], "nested-call");
  agent.updateNestedJoin(ownerRunId, index, { state: "interrupted", error: "cancelled" });

  expect(emitted.map(value => value.event)).toEqual(["subagent:updated", "subagent:updated"]);
  expect(emitted.map(value => value.data.kind)).toEqual(["nestedJoin", "nestedJoin"]);
  expect(emitted.every(value => value.data.runId === ownerRunId)).toBe(true);
  expect(emitted[1].data.snapshot.runs[0].nestedJoins[0]).toMatchObject({
    toolCallId: "nested-call",
    state: "interrupted",
    error: "cancelled",
  });
});
