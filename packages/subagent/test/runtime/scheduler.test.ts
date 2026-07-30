import { expect, test, vi } from "vitest";
import { Conversation } from "../../src/conversation.js";
import { completedRun } from "../../src/conversation.js";
import { RunScheduler } from "../../src/scheduler.js";

const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
const makeAgent = (conversationId: string, runId: string) => new Conversation(conversationId as any, runId as any, config, { kind: "spawn", agent: "worker", prompt: runId, label: runId }, () => {});
const session = () => ({ messages: [], subscribe: () => () => {}, abort() {} }) as any;

test("queue leases enforce concurrency and dispatch the next run after completion", async () => {
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const executor = new RunScheduler({ maxRunning: 1, executor: async (_ctx, agent, run) => {
    started.push(agent.conversationId);
    agent.bindSession(session());
    await new Promise<void>(resolve => releases.push(resolve));
    return completedRun(agent, run.runId, run.prompt);
  }});
  const first = makeAgent("amber-acorn", "adapt-ably");
  const second = makeAgent("brisk-birch", "balance-boldly");
  const p1 = executor.run({} as any, undefined, first, first.requireCurrentRun());
  const p2 = executor.run({} as any, undefined, second, second.requireCurrentRun());
  await vi.waitFor(() => expect(started).toEqual(["amber-acorn"]));
  releases.shift()!(); await p1;
  await vi.waitFor(() => expect(started).toEqual(["amber-acorn", "brisk-birch"]));
  releases.shift()!(); await expect(p2).resolves.toMatchObject({ status: { kind: "done", outcome: "completed" } });
});

test("an executor failure resolves the resumed run snapshot", async () => {
  const scheduler = new RunScheduler({ maxRunning: 1, executor: async (_ctx, agent, run) => {
    if (run.kind === "resume") throw new Error("resume failed");
    agent.bindSession(session());
    return completedRun(agent, run.runId, "spawned");
  }});
  const agent = makeAgent("amber-acorn", "adapt-ably");
  const spawn = agent.requireCurrentRun();
  await scheduler.run({} as any, undefined, agent, spawn);
  agent.markJoined(spawn.runId);
  const resume = agent.beginResume("balance-boldly" as any, "continue");

  await expect(scheduler.run({} as any, undefined, agent, resume)).resolves.toMatchObject({
    runId: "balance-boldly",
    kind: "resume",
    status: { kind: "done", outcome: "error" },
  });
});

test("suspending an active lease lets queued descendant work run before reacquisition", async () => {
  let releaseParent!: () => void;
  const parentMayFinish = new Promise<void>(resolve => { releaseParent = resolve; });
  const started: string[] = [];
  const executor = new RunScheduler({ maxRunning: 1, executor: async (_ctx, agent, run) => {
    started.push(agent.conversationId); agent.bindSession(session());
    if (agent.conversationId === "amber-acorn") await parentMayFinish;
    return completedRun(agent, run.runId, "done");
  }});
  const parent = makeAgent("amber-acorn", "adapt-ably");
  const child = makeAgent("brisk-birch", "balance-boldly");
  const parentRun = executor.run({} as any, undefined, parent, parent.requireCurrentRun());
  await vi.waitFor(() => expect(started).toEqual(["amber-acorn"]));
  const childRun = executor.run({} as any, undefined, child, child.requireCurrentRun());
  await executor.suspendAgentSlotDuring(parent.conversationId, async () => { await childRun; });
  expect(started).toEqual(["amber-acorn", "brisk-birch"]);
  releaseParent(); await parentRun;
});
