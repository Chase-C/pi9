import { expect, test, vi } from "vitest";
import { Agent } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { AttemptRunner } from "../../src/runtime/attempt-runner.js";

const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
const makeAgent = (conversationId: string, runId: string) => new Agent(conversationId as any, runId as any, config, { kind: "spawn", agent: "worker", prompt: runId }, () => {});
const session = () => ({ messages: [], subscribe: () => () => {}, abort() {} }) as any;

test("queue leases enforce concurrency and dispatch the next attempt after completion", async () => {
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const runner = new AttemptRunner({ maxRunning: 1, runner: async (_ctx, agent, attempt) => {
    started.push(agent.conversationId);
    agent.bindSession(session());
    await new Promise<void>(resolve => releases.push(resolve));
    return completedRun(agent, attempt.runId, attempt.prompt);
  }});
  const first = makeAgent("amber-acorn", "adapt-ably");
  const second = makeAgent("brisk-birch", "balance-boldly");
  const p1 = runner.run({} as any, undefined, first, first.requireCurrentAttempt());
  const p2 = runner.run({} as any, undefined, second, second.requireCurrentAttempt());
  await vi.waitFor(() => expect(started).toEqual(["amber-acorn"]));
  releases.shift()!(); await p1;
  await vi.waitFor(() => expect(started).toEqual(["amber-acorn", "brisk-birch"]));
  releases.shift()!(); await expect(p2).resolves.toMatchObject({ status: { kind: "done", outcome: "completed" } });
});

test("suspending an active lease lets queued descendant work run before reacquisition", async () => {
  let releaseParent!: () => void;
  const parentMayFinish = new Promise<void>(resolve => { releaseParent = resolve; });
  const started: string[] = [];
  const runner = new AttemptRunner({ maxRunning: 1, runner: async (_ctx, agent, attempt) => {
    started.push(agent.conversationId); agent.bindSession(session());
    if (agent.conversationId === "amber-acorn") await parentMayFinish;
    return completedRun(agent, attempt.runId, "done");
  }});
  const parent = makeAgent("amber-acorn", "adapt-ably");
  const child = makeAgent("brisk-birch", "balance-boldly");
  const parentRun = runner.run({} as any, undefined, parent, parent.requireCurrentAttempt());
  await vi.waitFor(() => expect(started).toEqual(["amber-acorn"]));
  const childRun = runner.run({} as any, undefined, child, child.requireCurrentAttempt());
  await runner.suspendAgentSlotDuring(parent.conversationId, async () => { await childRun; });
  expect(started).toEqual(["amber-acorn", "brisk-birch"]);
  releaseParent(); await parentRun;
});
