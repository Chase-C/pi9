import { test, expect } from "vitest";
import { SubagentRuntime } from "../../src/runtime.js";
import {
  projectSubagentGenerationIndex,
  registerSubagentLifecycleEvents,
  registerSubagentMetadataPersistence,
} from "../../src/index.js";
import { Conversation, completedGeneration, errorGeneration } from "../../src/conversation.js";
import type { ConversationId } from "../../src/identifiers.js";

const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
const registry = { agents: new Map([["worker", config]]) } as any;
const context = { cwd: "/tmp", modelRegistry: { find: () => undefined } } as any;

test("spawn publishes queued after manager conversation and generation indexes exist", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const manager = new SubagentRuntime(registry, 1, async (_ctx, agent, generation) => {
    await gate;
    agent.bindSession(generation, { messages: [], subscribe: () => () => {}, abort() {} } as any);
    return completedGeneration(agent, generation, "done");
  });
  const emitted: Array<{ event: string; data: any }> = [];
  const unsubscribe = registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, manager);
  const started = manager.startTasks(context, [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }] as any);
  const identity = started.starts[0] as any;
  const queued = emitted.find(value => value.event === "subagent:queued")!;
  expect(queued.data).toMatchObject({
    ok: true,
    subagentId: identity.conversationId,
    generation: 1,
    status: "queued",
    receipts: { user: false, model: false },
  });
  expect(queued.data).not.toHaveProperty("collected");
  expect(queued.data).not.toHaveProperty("joined");
  expect(manager.conversation(identity.conversationId).generations.some(generation => generation.generation === identity.generation)).toBe(true);
  expect(() => manager.bindSubagentJoin([identity.conversationId])).not.toThrow();
  release(); await started.completion; unsubscribe();
});

test("lifecycle events use the audience-neutral canonical block", async () => {
  const manager = new SubagentRuntime(registry, 1, async (_ctx, agent, generation) => {
    agent.bindSession(generation, { messages: [], subscribe: () => () => {}, abort() {} } as any);
    return completedGeneration(agent, generation, "done");
  });
  const emitted: Array<{ event: string; data: any }> = [];
  const unsubscribe = registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, manager);
  const started = manager.startTasks(context, [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }] as any);
  await started.completion;

  const subagentId = (started.starts[0] as any).conversationId;
  expect(emitted).toEqual([
    {
      event: "subagent:queued",
      data: {
        ok: true,
        subagentId,
        label: "work",
        agent: "worker",
        generation: 1,
        initiatedBy: "model",
        status: "queued",
        actionHints: ["cancel", "inspect", "join"],
        receipts: { user: false, model: false },
      },
    },
    {
      event: "subagent:started",
      data: {
        ok: true,
        subagentId,
        label: "work",
        agent: "worker",
        generation: 1,
        initiatedBy: "model",
        status: "running",
        actionHints: ["steer", "cancel", "inspect", "join"],
        receipts: { user: false, model: false },
      },
    },
    {
      event: "subagent:finished",
      data: {
        ok: true,
        subagentId,
        label: "work",
        agent: "worker",
        generation: 1,
        initiatedBy: "model",
        status: "completed",
        actionHints: ["inspect", "join", "remove"],
        receipts: { user: false, model: false },
      },
    },
  ]);
  expect(emitted.every(({ data }) => !("collected" in data) && !("joined" in data))).toBe(true);

  const finished = emitted.at(-1)!.data;
  manager.collectSubagentForUser(subagentId);
  expect(manager.generationSnapshot({ conversationId: subagentId, generation: 1 }).receipts.user).toBe(true);
  expect(emitted).toHaveLength(3);
  expect(finished.receipts).toEqual({ user: false, model: false });
  expect(Object.isFrozen(finished.receipts)).toBe(true);
  expect(() => { finished.receipts.user = true; }).toThrow();
  expect(finished.receipts).toEqual({ user: false, model: false });
  unsubscribe();
});

test("failed lifecycle events include the canonical failure text", async () => {
  const manager = new SubagentRuntime(registry, 1, async (_ctx, agent, generation) => {
    agent.bindSession(generation, { messages: [], subscribe: () => () => {}, abort() {} } as any);
    return errorGeneration(agent, generation, "provider rejected the request");
  });
  const emitted: Array<{ event: string; data: any }> = [];
  const unsubscribe = registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, manager);
  const started = manager.startTasks(context, [{ kind: "spawn", agent: "worker", prompt: "work", label: "failed work" }] as any);
  await started.completion;

  expect(emitted.at(-1)).toEqual({
    event: "subagent:finished",
    data: {
      ok: true,
      subagentId: (started.starts[0] as any).conversationId,
      label: "failed work",
      agent: "worker",
      generation: 1,
      initiatedBy: "model",
      status: "failed",
      actionHints: ["inspect", "join", "remove"],
      failure: "Subagent failed: provider rejected the request",
      receipts: { user: false, model: false },
    },
  });
  expect(emitted.at(-1)!.data).not.toHaveProperty("collected");
  expect(emitted.at(-1)!.data).not.toHaveProperty("joined");
  unsubscribe();
});

test("successive generations with equal timestamps publish distinct lifecycle events", () => {
  const conversationId = "calm-otter" as ConversationId;
  let listener: ((agent: Conversation, kind: any) => void) | undefined;
  let projectedGeneration = 1;
  const source = {
    onConversationUpdate: (next: typeof listener) => { listener = next; return () => {}; },
    projectSubagent: () => ({ ok: true as const, subagentId: conversationId, label: "delegate", agent: "worker", generation: projectedGeneration, initiatedBy: "model" as const, status: "completed" as const, collected: false, actionHints: [] }),
  };
  const emitted: Array<{ event: string; data: any }> = [];
  registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, source);
  const snapshot = (generation: number) => ({ generations: [{ generation, receipts: { user: false, model: false }, status: { kind: "done", outcome: "completed", completedAt: 7 } }] });
  const agent = { conversationId, snapshot: () => snapshot(1) } as any;
  listener?.(agent, "status");
  projectedGeneration = 2;
  agent.snapshot = () => snapshot(2);
  listener?.(agent, "status");

  expect(emitted.map(({ data }) => data.generation)).toEqual([1, 2]);
  expect(emitted.map(({ data }) => data.receipts)).toEqual([
    { user: false, model: false },
    { user: false, model: false },
  ]);
});

test("generation metadata uses the generation-native custom entry and projection", () => {
  let listener: ((agent: Conversation, kind: any) => void) | undefined;
  const entries: Array<{ customType: string; data: any }> = [];
  registerSubagentMetadataPersistence({
    appendEntry: (customType, data) => entries.push({ customType, data }),
  }, {
    onConversationUpdate: next => { listener = next; return () => {}; },
  });
  const snapshot = {
    conversationId: "calm-otter",
    label: "delegate",
    agent: { name: "worker" },
    generations: [{
      generation: 2,
      kind: "resume",
      initiatedBy: "user",
      createdAt: 3,
      status: { kind: "done", outcome: "completed", startedAt: 4, completedAt: 9 },
    }],
  } as any;
  const agent = { snapshot: () => snapshot } as Conversation;
  listener?.(agent, "status");
  listener?.(agent, "status");

  expect(entries).toEqual([{
    customType: "subagent-generation-index",
    data: {
      version: 4,
      subagentId: "calm-otter",
      generation: 2,
      agent: "worker",
      label: "delegate",
      kind: "resume",
      initiatedBy: "user",
      status: "completed",
      startedAt: 4,
      completedAt: 9,
      elapsedMs: 5,
    },
  }]);
  expect(projectSubagentGenerationIndex(snapshot)).toEqual(entries[0].data);
});

test("non-status changes do not publish public lifecycle events", () => {
  const conversationId = "calm-otter" as ConversationId;
  let listener: ((agent: Conversation, kind: any) => void) | undefined;
  const source = {
    onConversationUpdate: (next: typeof listener) => { listener = next; return () => {}; },
    projectSubagent: () => ({ ok: true as const, subagentId: conversationId, label: "delegate", agent: "worker", generation: 1, initiatedBy: "model" as const, status: "running" as const, collected: false as const, actionHints: [] }),
  };
  const emitted: Array<{ event: string; data: any }> = [];
  registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, source);
  const agent = new Conversation(
    conversationId,
    config,
    { kind: "spawn", agent: "worker", prompt: "delegate", label: "delegate" },
    (changed, kind) => listener?.(changed, kind),
  );
  emitted.length = 0;

  const index = agent.beginNestedJoin(agent.latestGeneration, [{ conversationId: "search-boldly" as ConversationId, generation: 1 }], "nested-call");
  agent.updateNestedJoin(agent.latestGeneration, index, { state: "interrupted", error: "cancelled" });

  expect(emitted).toEqual([]);
});
