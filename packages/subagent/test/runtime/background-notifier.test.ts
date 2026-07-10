import { test } from "vitest";
import assert from "node:assert/strict";

import { AgentManager } from "../../src/runtime/agent-manager.js";
import { BackgroundNotifier, type NotifierPi } from "../../src/runtime/background-notifier.js";
import { makeManager as buildManager } from "../helpers/runtime.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import type { BackgroundNotifyMode } from "../../src/config/settings.js";

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

interface FakeCtx {
  isIdle: () => boolean;
}

interface FakePi extends NotifierPi {
  fireAgentEnd: () => void;
  fireTurnEnd: () => void;
  fireToolExecutionStart: (event?: unknown) => void;
  fireSessionStart: (ctx: FakeCtx) => void;
  fireSessionShutdown: () => void;
  sent: SentMessage[];
}

function fakePi(): FakePi {
  const handlers = {
    agentEnd: [] as Array<(e: unknown, ctx?: FakeCtx) => void>,
    turnEnd: [] as Array<(e: unknown, ctx?: FakeCtx) => void>,
    toolStart: [] as Array<(e: unknown, ctx?: FakeCtx) => void>,
    sessionStart: [] as Array<(e: unknown, ctx?: FakeCtx) => void>,
    sessionShutdown: [] as Array<(e: unknown, ctx?: FakeCtx) => void>,
  };
  let currentCtx: FakeCtx | undefined;
  const sent: SentMessage[] = [];
  return {
    on(event: string, handler: any) {
      if (event === "agent_end") handlers.agentEnd.push(handler);
      else if (event === "turn_end") handlers.turnEnd.push(handler);
      else if (event === "tool_execution_start") handlers.toolStart.push(handler);
      else if (event === "session_start") handlers.sessionStart.push(handler);
      else if (event === "session_shutdown") handlers.sessionShutdown.push(handler);
    },
    sendMessage(message: any, options?: any) {
      sent.push({ ...message, options });
    },
    fireAgentEnd() {
      for (const h of handlers.agentEnd) h({}, currentCtx);
    },
    fireTurnEnd() {
      for (const h of handlers.turnEnd) h({}, currentCtx);
    },
    fireToolExecutionStart(event = {}) {
      for (const h of handlers.toolStart) h(event, currentCtx);
    },
    fireSessionStart(ctx: FakeCtx) {
      currentCtx = ctx;
      for (const h of handlers.sessionStart) h({}, ctx);
    },
    fireSessionShutdown() {
      const ctx = currentCtx;
      currentCtx = undefined;
      for (const h of handlers.sessionShutdown) h({}, ctx);
    },
    sent,
  };
}

interface ManualRetry {
  schedule: (fn: () => void, delayMs: number) => () => void;
  pending: () => number;
  flush: () => void;
  flushOne: () => void;
}

function manualRetry(): ManualRetry {
  const queue: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    schedule(fn, _delayMs) {
      const entry = { fn, cancelled: false };
      queue.push(entry);
      return () => { entry.cancelled = true; };
    },
    pending() {
      return queue.filter(e => !e.cancelled).length;
    },
    flush() {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (!entry.cancelled) entry.fn();
      }
    },
    flushOne() {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (!entry.cancelled) { entry.fn(); return; }
      }
    },
  };
}

const idleCtx: FakeCtx = { isIdle: () => true };

function makeManager(runner: any, resumeRunner?: any): AgentManager {
  const registry = {
    agents: new Map([
      ["oneshot", { name: "oneshot", description: "d", systemPrompt: "s", source: "project", resumable: false }],
      ["resumable", { name: "resumable", description: "d", systemPrompt: "s", source: "project", resumable: true }],
    ]),
  };
  const combined = (ctx: any, agent: any, attempt: any, signal: any) =>
    attempt.kind === "resume" ? (resumeRunner ?? runner)(ctx, agent, attempt, signal) : runner(ctx, agent, attempt, signal);
  return buildManager(registry as any, 2, combined);
}

async function runBackgroundOne(manager: AgentManager, prompt = "go") {
  const handle = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt }],
    undefined,
    { background: true },
  );
  await handle.resultsPromise;
  return handle.sessions[0].id;
}

const completingRunner = async (_ctx: any, agent: any, _attempt: any) => {
  agent.attach(makeSession());
  return completedRun(agent, "ok");
};

test("BackgroundNotifier in auto mode immediately starts a parent turn when a completion arrives while idle", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "auto" });

  pi.fireSessionStart(idleCtx);
  const sessionId = await runBackgroundOne(manager);

  assert.equal(pi.sent.length, 1, "one message when the idle completion arrives");
  assert.equal(pi.sent[0].options?.triggerTurn, true);
  assert.equal(pi.sent[0].options?.deliverAs, undefined);
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 1, "agent_end does not duplicate the already-sent notification");

  notifier.unsubscribe();
});

test("BackgroundNotifier unsubscribe() detaches from the manager so later completions are not delivered", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "auto" });

  pi.fireSessionStart(idleCtx);
  notifier.unsubscribe();

  // A background subagent completes after unsubscribe; the detached notifier must not react.
  await runBackgroundOne(manager);
  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 0, "no delivery for completions arriving after unsubscribe");
});

test("BackgroundNotifier in auto mode does not duplicate an idle completion on turn_end", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "auto" });

  pi.fireSessionStart(idleCtx);
  const sessionId = await runBackgroundOne(manager);

  pi.fireTurnEnd();
  assert.equal(pi.sent.length, 1, "turn_end does not duplicate the already-sent notification");
  assert.equal(pi.sent[0].options?.triggerTurn, true);
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  notifier.unsubscribe();
});

test("BackgroundNotifier on session_shutdown cancels the pending retry and prevents delivery through the stale context", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const retry = manualRetry();
  let idle = false;
  const ctx: FakeCtx = { isIdle: () => idle };
  const notifier = new BackgroundNotifier({
    pi,
    manager,
    getMode: () => "auto",
    scheduleRetry: retry.schedule,
  });

  pi.fireSessionStart(ctx);
  await runBackgroundOne(manager);
  pi.fireAgentEnd();
  assert.equal(retry.pending(), 1);

  pi.fireSessionShutdown();
  assert.equal(retry.pending(), 0, "session_shutdown cancels the pending retry");

  idle = true;
  retry.flush();
  assert.equal(pi.sent.length, 0, "stale ctx becoming idle does not trigger delivery");

  notifier.unsubscribe();
});

test("BackgroundNotifier delivers queued completions after a new session_start replaces the cleared context", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const retry = manualRetry();
  const notifier = new BackgroundNotifier({
    pi,
    manager,
    getMode: () => "auto",
    scheduleRetry: retry.schedule,
  });

  pi.fireSessionStart({ isIdle: () => false });
  const sessionId = await runBackgroundOne(manager);
  pi.fireAgentEnd();
  pi.fireSessionShutdown();
  assert.equal(pi.sent.length, 0);

  // A new session arrives, already idle.
  pi.fireSessionStart(idleCtx);
  assert.equal(pi.sent.length, 1, "queued completion delivered through fresh idle context");
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  notifier.unsubscribe();
});

test("BackgroundNotifier coalesces completions that arrive during the idle wait into a single delivered message", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const retry = manualRetry();
  let idle = false;
  const ctx: FakeCtx = { isIdle: () => idle };
  const notifier = new BackgroundNotifier({
    pi,
    manager,
    getMode: () => "auto",
    scheduleRetry: retry.schedule,
  });

  pi.fireSessionStart(ctx);
  const id1 = await runBackgroundOne(manager, "one");

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 0);
  assert.equal(retry.pending(), 1);

  // A second completion arrives while we're still waiting for idle.
  const id2 = await runBackgroundOne(manager, "two");
  retry.flushOne();
  assert.equal(pi.sent.length, 0, "still not idle — no delivery yet");

  // A third completion arrives during the next wait.
  const id3 = await runBackgroundOne(manager, "three");
  idle = true;
  retry.flushOne();

  assert.equal(pi.sent.length, 1, "single coalesced delivery once idle");
  const text = pi.sent[0].content ?? "";
  for (const id of [id1, id2, id3]) assert.match(text, new RegExp(id));
  assert.match(text, /3 background subagents completed/);

  notifier.unsubscribe();
});

test("BackgroundNotifier in auto mode defers send while ctx.isIdle() is false, then sends one message when a retry sees idle=true", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const retry = manualRetry();
  let idle = false;
  const ctx: FakeCtx = { isIdle: () => idle };
  const notifier = new BackgroundNotifier({
    pi,
    manager,
    getMode: () => "auto",
    scheduleRetry: retry.schedule,
  });

  pi.fireSessionStart(ctx);
  const sessionId = await runBackgroundOne(manager);

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 0, "no message while not idle");
  assert.equal(retry.pending(), 1, "retry scheduled while not idle");

  retry.flushOne();
  assert.equal(pi.sent.length, 0, "still no message; ctx still not idle");
  assert.equal(retry.pending(), 1, "retry re-scheduled after seeing not-idle");

  idle = true;
  retry.flushOne();
  assert.equal(pi.sent.length, 1, "one message after retry sees idle=true");
  assert.equal(pi.sent[0].options?.triggerTurn, true);
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));
  assert.equal(retry.pending(), 0, "no further retries pending");

  notifier.unsubscribe();
});

test("BackgroundNotifier drops a queued completion when its session is removed before dispatch", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const retry = manualRetry();
  let idle = false;
  const notifier = new BackgroundNotifier({
    pi,
    manager,
    getMode: () => "auto",
    scheduleRetry: retry.schedule,
  });

  pi.fireSessionStart({ isIdle: () => idle });
  const sessionId = await runBackgroundOne(manager);
  assert.equal(retry.pending(), 1);

  await manager.remove({ sessionIds: [sessionId] });
  idle = true;
  retry.flushOne();

  assert.equal(pi.sent.length, 0, "removed sessions must not produce stale retrieval instructions");
  notifier.unsubscribe();
});

test("BackgroundNotifier drops a queued completion after results retrieves it", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const retry = manualRetry();
  let idle = false;
  const notifier = new BackgroundNotifier({
    pi,
    manager,
    getMode: () => "auto",
    scheduleRetry: retry.schedule,
  });

  pi.fireSessionStart({ isIdle: () => idle });
  const sessionId = await runBackgroundOne(manager);
  assert.equal(retry.pending(), 1);

  const [entry] = manager.backgroundResults([sessionId]);
  assert.ok("snapshot" in entry && entry.snapshot.status.kind === "done");
  idle = true;
  retry.flushOne();

  assert.equal(pi.sent.length, 0, "retrieved results acknowledge pending completion notifications");
  notifier.unsubscribe();
});

test("BackgroundNotifier suppresses results-targeted completions before a steer flush", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "steer" });

  const retrievedId = await runBackgroundOne(manager, "retrieved");
  const pendingId = await runBackgroundOne(manager, "pending");

  pi.fireToolExecutionStart({
    type: "tool_execution_start",
    toolName: "subagent",
    args: { action: "results", sessionIds: [retrievedId] },
  });

  assert.equal(pi.sent.length, 1, "the unrelated completion still triggers a steer notification");
  assert.doesNotMatch(pi.sent[0].content ?? "", new RegExp(retrievedId));
  assert.match(pi.sent[0].content ?? "", new RegExp(pendingId));
  notifier.unsubscribe();
});

test("BackgroundNotifier drops pending auto notification if mode flips to none before retry sees idle", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const retry = manualRetry();
  let mode: BackgroundNotifyMode = "auto";
  let idle = false;
  const ctx: FakeCtx = { isIdle: () => idle };
  const notifier = new BackgroundNotifier({
    pi,
    manager,
    getMode: () => mode,
    scheduleRetry: retry.schedule,
  });

  pi.fireSessionStart(ctx);
  await runBackgroundOne(manager);
  pi.fireAgentEnd();
  assert.equal(retry.pending(), 1, "retry scheduled while not idle");

  mode = "none";
  idle = true;
  retry.flushOne();

  assert.equal(pi.sent.length, 0, "no auto delivery after mode flips to none");
  assert.equal(retry.pending(), 0, "no retry remains after mode flips to none");

  mode = "auto";
  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 0, "dropped completion is not resurrected later");

  notifier.unsubscribe();
});

test("BackgroundNotifier leaves pending auto notification for steer delivery if mode flips to steer before retry sees idle", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const retry = manualRetry();
  let mode: BackgroundNotifyMode = "auto";
  let idle = false;
  const ctx: FakeCtx = { isIdle: () => idle };
  const notifier = new BackgroundNotifier({
    pi,
    manager,
    getMode: () => mode,
    scheduleRetry: retry.schedule,
  });

  pi.fireSessionStart(ctx);
  const sessionId = await runBackgroundOne(manager);
  pi.fireAgentEnd();
  assert.equal(retry.pending(), 1, "retry scheduled while not idle");

  mode = "steer";
  idle = true;
  retry.flushOne();

  assert.equal(pi.sent.length, 0, "pending retry does not auto-deliver after mode flips to steer");
  assert.equal(retry.pending(), 0, "auto retry stops in steer mode");

  pi.fireToolExecutionStart();
  assert.equal(pi.sent.length, 1, "queued completion remains available for steer delivery");
  assert.equal(pi.sent[0].options?.deliverAs, "steer");
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  notifier.unsubscribe();
});

test("BackgroundNotifier payload references subagent results, includes per-session metadata, and never includes output or error from the child", async () => {
  const manager = makeManager(async (_ctx: any, agent: any, _attempt: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "SUPER-SECRET-CHILD-OUTPUT");
  });
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "auto" });

  pi.fireSessionStart(idleCtx);
  const batch = manager.startRun(
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

  notifier.unsubscribe();
});

test("BackgroundNotifier in none mode drops completions immediately and never re-emits later", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  let mode: BackgroundNotifyMode = "none";
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => mode });

  pi.fireSessionStart(idleCtx);
  await runBackgroundOne(manager);

  assert.equal(pi.sent.length, 0);

  // Switching back to auto must not resurrect the drained completion.
  mode = "auto";
  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 0);

  notifier.unsubscribe();
});

test("BackgroundNotifier coalesces queued completions into a single dispatched message on session_start", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "auto" });

  const id1 = await runBackgroundOne(manager, "one");
  const id2 = await runBackgroundOne(manager, "two");
  const id3 = await runBackgroundOne(manager, "three");

  pi.fireSessionStart(idleCtx);
  assert.equal(pi.sent.length, 1);
  const text = pi.sent[0].content ?? "";
  for (const id of [id1, id2, id3]) assert.match(text, new RegExp(id));
  assert.match(text, /3 background subagents completed/);

  notifier.unsubscribe();
});

test("BackgroundNotifier in steer mode fires no message until tool_execution_start, then exactly one", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "steer" });

  const sessionId = await runBackgroundOne(manager);

  pi.fireAgentEnd();
  assert.equal(pi.sent.length, 0, "agent_end does not trigger steer dispatch");

  pi.fireToolExecutionStart();
  assert.equal(pi.sent.length, 1, "one message on tool_execution_start");
  assert.equal(pi.sent[0].options?.deliverAs, "steer");
  assert.equal(pi.sent[0].options?.triggerTurn, undefined, "steer must not use triggerTurn");
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  notifier.unsubscribe();
});

test("BackgroundNotifier in steer mode starts a parent turn when a completion arrives while idle", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "steer" });

  pi.fireSessionStart(idleCtx);
  const sessionId = await runBackgroundOne(manager);

  assert.equal(pi.sent.length, 1, "one parent-turn message when the idle completion arrives");
  assert.equal(pi.sent[0].options?.triggerTurn, true);
  assert.equal(pi.sent[0].options?.deliverAs, undefined);
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  notifier.unsubscribe();
});

test("BackgroundNotifier in steer mode coalesces multiple completions into a single steer message on tool_execution_start", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "steer" });

  const id1 = await runBackgroundOne(manager, "one");
  const id2 = await runBackgroundOne(manager, "two");
  const id3 = await runBackgroundOne(manager, "three");

  pi.fireAgentEnd();
  pi.fireTurnEnd();
  assert.equal(pi.sent.length, 0, "neither agent_end nor turn_end dispatches steer");

  pi.fireToolExecutionStart();
  assert.equal(pi.sent.length, 1, "single coalesced steer dispatch on tool_execution_start");
  assert.equal(pi.sent[0].options?.deliverAs, "steer");
  const text = pi.sent[0].content ?? "";
  for (const id of [id1, id2, id3]) assert.match(text, new RegExp(id));
  assert.match(text, /3 background subagents completed/);

  pi.fireToolExecutionStart();
  assert.equal(pi.sent.length, 1, "queue is drained after dispatch; no second steer fires");

  notifier.unsubscribe();
});

test("BackgroundNotifier in steer mode payload contains per-session metadata, references subagent results, and never includes child output or error", async () => {
  const manager = makeManager(async (_ctx: any, agent: any, _attempt: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "SUPER-SECRET-CHILD-OUTPUT");
  });
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "steer" });

  const batch = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "go", label: "steer-only" }],
    undefined,
    { background: true },
  );
  await batch.resultsPromise;
  const sessionId = batch.sessions[0].id;

  pi.fireToolExecutionStart();
  assert.equal(pi.sent.length, 1);
  const text = pi.sent[0].content ?? "";
  const json = JSON.stringify(pi.sent[0]);

  assert.match(text, new RegExp(sessionId));
  assert.match(text, /oneshot/);
  assert.match(text, /steer-only/);
  assert.match(text, /completed/);
  assert.match(text, /subagent results/);
  assert.doesNotMatch(json, /SUPER-SECRET-CHILD-OUTPUT/);

  notifier.unsubscribe();
});

test("BackgroundNotifier in steer mode immediately steers an active parent run without scheduling auto retry", async () => {
  const manager = makeManager(completingRunner);
  const pi = fakePi();
  const retry = manualRetry();
  const notifier = new BackgroundNotifier({
    pi,
    manager,
    getMode: () => "steer",
    scheduleRetry: retry.schedule,
  });

  // With a non-idle ctx, steer should inject into the active run and must not engage the auto idle flush path.
  pi.fireSessionStart({ isIdle: () => false });
  const sessionId = await runBackgroundOne(manager);

  assert.equal(retry.pending(), 0, "no auto idle retry scheduled while in steer mode");
  assert.equal(pi.sent.length, 1, "one steer message when the active-run completion arrives");
  assert.equal(pi.sent[0].options?.deliverAs, "steer");
  assert.match(pi.sent[0].content ?? "", new RegExp(sessionId));

  pi.fireAgentEnd();
  pi.fireTurnEnd();
  assert.equal(pi.sent.length, 1, "agent_end / turn_end do not duplicate the steer notification");

  notifier.unsubscribe();
});

test("BackgroundNotifier notifies again when a background session resumes and completes with the same sessionId", async () => {
  const runner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "ok");
  };
  const resumeRunner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.attach(makeSession());
    return completedRun(agent, "ok again", true);
  };
  const manager = makeManager(runner, resumeRunner);
  const pi = fakePi();
  const notifier = new BackgroundNotifier({ pi, manager, getMode: () => "auto" });

  pi.fireSessionStart(idleCtx);
  const batch = manager.startRun(
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
  manager.backgroundResults([sessionId]);

  const resumed = manager.startRun(
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

  notifier.unsubscribe();
});
