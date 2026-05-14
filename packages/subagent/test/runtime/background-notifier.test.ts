import { test } from "vitest";
import assert from "node:assert/strict";

import { AgentManager } from "../../src/runtime/agent-manager.js";
import { BackgroundNotifier, type NotifierPi } from "../../src/runtime/background-notifier.js";
import { completedRun } from "../../src/domain/agent-result.js";
import type { BackgroundNotifyMode } from "../../src/ui/settings.js";

const baseCtx = () => ({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } } as any);
const makeSession = () => ({
  messages: [] as any[],
  subscribe: () => () => {},
  prompt: async () => {},
  abort: () => {},
});

interface SentMessage {
  customType?: string;
  content?: string;
  details?: unknown;
  options?: { triggerTurn?: boolean; deliverAs?: string };
}

interface FakePi extends NotifierPi {
  fireAgentEnd: () => void;
  fireToolExecutionStart: () => void;
  sent: SentMessage[];
}

function fakePi(): FakePi {
  const handlers: { agentEnd: Array<() => void>; toolStart: Array<() => void> } = {
    agentEnd: [],
    toolStart: [],
  };
  const sent: SentMessage[] = [];
  return {
    on(event: string, handler: any) {
      if (event === "agent_end") handlers.agentEnd.push(handler);
      else if (event === "tool_execution_start") handlers.toolStart.push(handler);
    },
    sendMessage(message: any, options?: any) {
      sent.push({ ...message, options });
    },
    fireAgentEnd() {
      for (const h of handlers.agentEnd) h();
    },
    fireToolExecutionStart() {
      for (const h of handlers.toolStart) h();
    },
    sent,
  };
}

function makeManager(runner: any, resumeRunner?: any) {
  const registry = {
    agents: new Map([
      ["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }],
      ["resumable", { name: "resumable", description: "d", systemPrompt: "s", source: "project", resumable: true }],
    ]),
  };
  const combined = (ctx: any, agent: any, attempt: any, signal: any) =>
    attempt.kind === "resume" ? (resumeRunner ?? runner)(ctx, agent, attempt, signal) : runner(ctx, agent, attempt, signal);
  return new AgentManager(registry as any, 2, combined);
}

async function runBackgroundOne(manager: AgentManager, prompt = "go") {
  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;
  return batch.sessions[0].id;
}

const completingRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
  agent.attach(makeSession());
  return completedRun(agent, "ok");
};

test("BackgroundNotifier in end-of-turn mode fires no message until agent_end, then exactly one with the completed sessionId", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "end-of-turn" });

  const sessionId = await runBackgroundOne(manager);

  assert.equal(pi.sent.length, 0, "no message before agent_end");

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 1, "one message on agent_end");
  assert.equal(pi.sent[0].options?.deliverAs, "followUp");
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  notifier.dispose();
});

test("BackgroundNotifier payload references subagent results, includes per-session metadata, and never includes output or error from the child", async () => {
  const manager = makeManager(async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "SUPER-SECRET-CHILD-OUTPUT");
  });
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "end-of-turn" });

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "go", label: "scout one" }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;
  const sessionId = batch.sessions[0].id;

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 1);
  const text = pi.sent[0].content ?? "";
  const json = JSON.stringify(pi.sent[0]);

  assert.match(text, new RegExp(sessionId));
  assert.match(text, /oneshot/);
  assert.match(text, /scout one/);
  assert.match(text, /completed/);
  assert.match(text, /subagent results/);
  assert.doesNotMatch(json, /SUPER-SECRET-CHILD-OUTPUT/);

  notifier.dispose();
});

test("BackgroundNotifier drops queued completions when none mode sees a dispatch event", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  let mode: BackgroundNotifyMode = "end-of-turn";
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => mode });

  await runBackgroundOne(manager);

  mode = "none";
  pi.fireAgentEnd();
  mode = "end-of-turn";
  pi.fireAgentEnd();

  assert.equal(pi.sent.length, 0);

  notifier.dispose();
});

test("BackgroundNotifier coalesces three quick completions into a single dispatched message", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "end-of-turn" });

  const id1 = await runBackgroundOne(manager, "one");
  const id2 = await runBackgroundOne(manager, "two");
  const id3 = await runBackgroundOne(manager, "three");

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 1);
  const text = pi.sent[0].content ?? "";
  for (const id of [id1, id2, id3]) assert.match(text, new RegExp(id));
  assert.match(text, /3 background subagents completed/);

  notifier.dispose();
});

test("BackgroundNotifier in none mode never dispatches even when completions and events occur", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "none" });

  await runBackgroundOne(manager);

  pi.fireAgentEnd();
  pi.fireToolExecutionStart();
  assert.equal(pi.sent.length, 0);

  notifier.dispose();
});

test("BackgroundNotifier in next-tool-call mode fires no message until tool_execution_start, then exactly one", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "next-tool-call" });

  const sessionId = await runBackgroundOne(manager);

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 0, "agent_end does not trigger next-tool-call dispatch");

  pi.fireToolExecutionStart();
  assert.equal(pi.sent.length, 1, "one message on tool_execution_start");
  assert.equal(pi.sent[0].options?.deliverAs, "steer");
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  notifier.dispose();
});

test("BackgroundNotifier notifies again when a background session resumes and completes with the same sessionId", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "ok");
  };
  const resumeRunner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach(makeSession());
    return completedRun(agent, "ok again", true);
  };
  const manager = makeManager(runner, resumeRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "end-of-turn" });

  const batch = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "resumable", prompt: "go" }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;
  const sessionId = batch.sessions[0].id;

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 1);
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  const resumed = manager.startBatch(
    baseCtx(),
    undefined,
    [{ kind: "resume", sessionId, prompt: "continue" }],
    undefined,
    { background: true },
  );
  await resumed.resultsPromise;

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 2);
  assert.match(pi.sent[1].content ?? "", new RegExp(sessionId));

  notifier.dispose();
});
