import { expect, test, vi } from "vitest";
import { Conversation, completedGeneration } from "../../src/conversation.js";
import { GenerationScheduler } from "../../src/scheduler.js";

const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
const makeAgent = (conversationId: string, prompt: string) => new Conversation(conversationId as any, config, { kind: "spawn", agent: "worker", prompt, label: prompt }, () => {});
const session = () => ({ messages: [], subscribe: () => () => {}, abort() {} }) as any;

test("queue leases enforce concurrency and dispatch the next generation after completion", async () => {
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const scheduler = new GenerationScheduler({ maxExecuting: 1, executor: async (_ctx, conversation, generation) => {
    started.push(conversation.conversationId);
    conversation.bindSession(generation, session());
    await new Promise<void>(resolve => releases.push(resolve));
    return completedGeneration(conversation, generation, generation.prompt);
  }});
  const first = makeAgent("amber-acorn", "first");
  const second = makeAgent("brisk-birch", "second");
  const p1 = scheduler.schedule({} as any, undefined, first, first.latestGeneration);
  const p2 = scheduler.schedule({} as any, undefined, second, second.latestGeneration);
  await vi.waitFor(() => expect(started).toEqual(["amber-acorn"]));
  releases.shift()!(); await p1;
  await vi.waitFor(() => expect(started).toEqual(["amber-acorn", "brisk-birch"]));
  releases.shift()!(); await expect(p2).resolves.toMatchObject({ status: { kind: "done", outcome: "completed" } });
});

test("an executor failure resolves the resumed generation snapshot", async () => {
  const scheduler = new GenerationScheduler({ maxExecuting: 1, executor: async (_ctx, conversation, generation) => {
    if (generation.kind === "resume") throw new Error("resume failed");
    conversation.bindSession(generation, session());
    return completedGeneration(conversation, generation, "spawned");
  }});
  const conversation = makeAgent("amber-acorn", "first");
  const spawn = conversation.latestGeneration;
  await scheduler.schedule({} as any, undefined, conversation, spawn);
  conversation.markCollected(spawn, "model");
  const resume = conversation.beginResume("continue");

  await expect(scheduler.schedule({} as any, undefined, conversation, resume)).resolves.toMatchObject({
    generation: 2,
    kind: "resume",
    status: { kind: "done", outcome: "error" },
  });
});

test("suspending an active lease lets queued descendant work execute before reacquisition", async () => {
  let releaseParent!: () => void;
  const parentMayFinish = new Promise<void>(resolve => { releaseParent = resolve; });
  const started: string[] = [];
  const scheduler = new GenerationScheduler({ maxExecuting: 1, executor: async (_ctx, conversation, generation) => {
    started.push(conversation.conversationId);
    conversation.bindSession(generation, session());
    if (conversation.conversationId === "amber-acorn") await parentMayFinish;
    return completedGeneration(conversation, generation, "done");
  }});
  const parent = makeAgent("amber-acorn", "parent");
  const child = makeAgent("brisk-birch", "child");
  const parentCompletion = scheduler.schedule({} as any, undefined, parent, parent.latestGeneration);
  await vi.waitFor(() => expect(started).toEqual(["amber-acorn"]));
  const childCompletion = scheduler.schedule({} as any, undefined, child, child.latestGeneration);
  await scheduler.suspendConversationSlotDuring(parent, async () => { await childCompletion; });
  expect(started).toEqual(["amber-acorn", "brisk-birch"]);
  releaseParent(); await parentCompletion;
});
