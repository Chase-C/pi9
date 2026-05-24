import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentStatus, type AgentUpdateListener } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { toResultJson } from "../../src/domain/agent-result.js";

const noop: AgentUpdateListener = () => {};
const view = (agent: Agent) => agent.snapshot();

function doneStatus(agent: Agent): Extract<AgentStatus, { kind: "done" }> {
  if (agent.status.kind !== "done") throw new Error(`expected done, got ${agent.status.kind}`);
  return agent.status;
}

const baseConfig = {
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
  resumable: false,
};

/**
 * Builds a single-agent registry plus a `findAgent` shim so Agent.resolve can be exercised
 * directly. The returned `resolve` invokes the static factory with sensible defaults — tests
 * pass the listener if they want to observe update emissions.
 */
function resolveScenario(opts: { config?: any } = {}) {
  const registry = {
    agents: new Map([[ (opts.config ?? baseConfig).name, opts.config ?? baseConfig ]]),
  } as any;
  const tracked: Agent[] = [];
  const findAgent = (id: string) => tracked.find(a => a.id === id);
  function resolve(task: any, listener: AgentUpdateListener = noop, background = false) {
    const result = Agent.resolve({
      task, background, groupId: "g", inputIndex: 0, createdAt: Date.now(),
      registry, findAgent, listener,
    });
    if (result.kind === "spawn") tracked.push(result.agent);
    return result;
  }
  return { registry, tracked, resolve };
}

test("Agent label surfaces through both the getter and projectAgentView, including the absent case", () => {
  const labeled = new Agent("id1", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", label: "researcher" }, noop);
  assert.equal(labeled.label, "researcher");
  assert.equal(view(labeled).label, "researcher");

  const unlabeled = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  assert.equal(unlabeled.label, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(view(unlabeled), "label"), false);
});

test("Agent stores optional parentId from constructor options", () => {
  const child = new Agent("id1", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop, { parentId: "root-1" });
  assert.equal(child.parentId, "root-1");

  const orphan = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.equal(orphan.parentId, undefined);
});

test("projectAgentView surfaces parentSessionId when set and omits it when absent", () => {
  const child = new Agent("id1", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop, { parentId: "root-1" });
  assert.equal(view(child).parentSessionId, "root-1");

  const orphan = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.equal(Object.prototype.hasOwnProperty.call(view(orphan), "parentSessionId"), false);
});

test("Agent constructor optional background flag controls projected dispatch", () => {
  const defaultAgent = new Agent("id1", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.equal(defaultAgent.background, false);
  assert.equal(view(defaultAgent).dispatch, "foreground");

  const backgroundAgent = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop, { background: true });
  assert.equal(backgroundAgent.background, true);
  assert.equal(view(backgroundAgent).dispatch, "background");
});

test("projectAgentView surfaces the default skills from the agent config", () => {
  const config = { ...baseConfig, skills: ["foo", "bar"] };
  const agent = new Agent("id", config, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  assert.deepEqual(view(agent).config.skills, ["foo", "bar"]);

  const noSkills = new Agent("id2", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);
  assert.equal(view(noSkills).config.skills, undefined);
});

test("Agent per-task resumable beats the config default in both directions", () => {
  for (const [configDefault, override] of [[true, false], [false, true]] as const) {
    const config = { ...baseConfig, resumable: configDefault };
    const agent = new Agent("id", config, { kind: "spawn", agent: "helper", prompt: "work", resumable: override }, noop);
    assert.equal(agent.resumable, override);
    assert.equal(view(agent).config.resumable, override);
  }
});

test("Agent.resolve keeps the stored label when omitted on resume and overwrites it when provided", () => {
  const session = { subscribe: () => () => { }, abort: () => { } };
  const updates: string[] = [];
  const { resolve } = resolveScenario({ config: { ...baseConfig, resumable: true } });

  const spawn = resolve(
    { kind: "spawn", agent: "helper", prompt: "work", label: "researcher" },
    (_a, kind) => updates.push(kind),
  );
  if (spawn.kind !== "spawn") throw new Error("expected spawn");
  spawn.agent.attach(session as any);
  completedRun(spawn.agent, "done");
  assert.equal(spawn.agent.label, "researcher");

  // Resume with no label: existing label is preserved.
  const r1 = resolve(
    { kind: "resume", sessionId: spawn.agent.id, prompt: "follow-up" },
    (_a, kind) => updates.push(kind),
  );
  if (r1.kind !== "resume") throw new Error("expected resume");
  assert.equal(r1.agent.label, "researcher");
  completedRun(r1.agent, "done again", true);

  // Resume with an explicit label and a per-attempt resumable override.
  const r2 = resolve(
    { kind: "resume", sessionId: spawn.agent.id, prompt: "follow-up", label: "renamed", resumable: false },
    (_a, kind) => updates.push(kind),
  );
  if (r2.kind !== "resume") throw new Error("expected resume");
  assert.equal(r2.agent.label, "renamed");
  assert.equal(r2.agent.resumableOverride, false);
  // Spawn settle + each resume emits a "status" update at minimum.
  assert.ok(updates.filter(k => k === "status").length >= 4, `expected several status updates, got ${updates.join(",")}`);
});

test("Agent.resolve re-subscribes the session on resume so events during a resumed cycle update its state", () => {
  let emit: ((event: any) => void) | undefined;
  const session = {
    messages: [],
    subscribe(handler: any) { emit = handler; return () => { emit = undefined; }; },
    prompt: async () => { },
    abort: () => { },
  };
  const { resolve } = resolveScenario({ config: { ...baseConfig, resumable: true, name: "a" } });
  const spawn = resolve({ kind: "spawn", agent: "a", prompt: "p" });
  if (spawn.kind !== "spawn") throw new Error("expected spawn");
  const agent = spawn.agent;

  agent.attach(session as any);
  const firstEmit = emit;
  assert.ok(firstEmit);
  firstEmit({ type: "turn_end" });
  assert.equal(view(agent).activity.turns, 1);
  completedRun(agent, "done");
  assert.equal(emit, undefined, "subscription should be torn down on complete");

  const resumed = resolve({ kind: "resume", sessionId: agent.id, prompt: "p2" });
  if (resumed.kind !== "resume") throw new Error("expected resume");
  agent.attach(session as any);
  const resumedEmit = emit as ((event: any) => void) | undefined;
  assert.ok(resumedEmit, "resume should re-subscribe");
  resumedEmit({ type: "turn_end" });
  resumedEmit({ type: "tool_execution_start", toolName: "read" });
  const resumedActivity = view(agent).activity;
  assert.equal(resumedActivity.turns, 2);
  assert.equal(resumedActivity.toolHistory.length, 1);
  completedRun(agent, "done2");
  assert.equal(emit, undefined, "subscription should be torn down on complete after resume");
});

test("agent stores tool-use history and keeps active tool correct for overlapping executions", () => {
  let sessionEmit: ((event: any) => void) | undefined;
  const session = {
    messages: [],
    subscribe(handler: any) { sessionEmit = handler; return () => { sessionEmit = undefined; }; },
    prompt: async () => { },
    abort: () => { },
  };
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "a", prompt: "p" }, noop);

  const activeNames = () =>
    view(agent).activity.toolHistory.filter(t => t.completedAt === undefined).map(t => t.name);

  agent.attach(session as any);
  assert.ok(sessionEmit);
  sessionEmit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
  sessionEmit({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash" });
  assert.deepEqual(activeNames(), ["read", "bash"]);

  sessionEmit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false });
  const finalHistory = view(agent).activity.toolHistory;
  assert.deepEqual(activeNames(), ["bash"]);
  assert.equal(finalHistory.length, 2);
  assert.deepEqual(
    finalHistory.map(tool => [tool.id, tool.name, Boolean(tool.completedAt), tool.isError]),
    [
      ["read-1", "read", true, false],
      ["bash-1", "bash", false, undefined],
    ],
  );
});

test("Agent.abort on a running agent aborts the underlying session and finalizes as aborted", async () => {
  let abortCalls = 0;
  const session = { messages: [], subscribe: () => () => { }, prompt: async () => { }, abort: () => { abortCalls += 1; } };
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(session as any);

  await agent.abort();

  assert.equal(abortCalls, 1);
  assert.equal(doneStatus(agent).result.status, "aborted");
});

test("Agent.abort on a queued agent finalizes as skipped without touching a session", async () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.equal(agent.status.kind, "queued");

  await agent.abort();

  assert.equal(doneStatus(agent).result.status, "skipped");
});

test("Agent.abort on a terminal agent is a no-op and does not re-finalize", async () => {
  let abortCalls = 0;
  const session = { messages: [], subscribe: () => () => { }, prompt: async () => { }, abort: () => { abortCalls += 1; } };
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(session as any);
  completedRun(agent, "done");
  const settled = doneStatus(agent).result;

  await agent.abort();

  assert.equal(abortCalls, 0);
  assert.equal(doneStatus(agent).result, settled);
});

test("Agent.resolve spawn for an unknown agent returns a preflight failure with a helpful error", () => {
  const registry = { agents: new Map() } as any;
  const result = Agent.resolve({
    task: { kind: "spawn", agent: "missing", prompt: "p" },
    background: false,
    groupId: "g",
    inputIndex: 0,
    createdAt: 1,
    registry,
    findAgent: () => undefined,
    listener: noop,
  });

  assert.equal(result.kind, "failure");
  if (result.kind !== "failure") return;
  assert.match(toResultJson(result.failure).error ?? "", /Unknown agent: missing/);
  assert.equal(result.failure.status.kind, "done");
});

test("Agent.resolve resume rejects sessions that are mid-attempt or non-resumable, leaving the existing attempt intact", () => {
  const { resolve, tracked } = resolveScenario({ config: { ...baseConfig, resumable: true } });
  const spawn = resolve({ kind: "spawn", agent: "helper", prompt: "work" });
  if (spawn.kind !== "spawn") throw new Error("expected spawn");

  // Attempt resume while the original spawn is still queued (mid-attempt) — should fail.
  const midAttempt = resolve({ kind: "resume", sessionId: spawn.agent.id, prompt: "queue jump" });
  assert.equal(midAttempt.kind, "failure");
  if (midAttempt.kind === "failure") assert.match(toResultJson(midAttempt.failure).error ?? "", /already.*resum|while it is/i);

  // Unknown session id surfaces a dedicated message.
  const unknown = resolve({ kind: "resume", sessionId: "no-such-id", prompt: "ghost" });
  assert.equal(unknown.kind, "failure");
  if (unknown.kind === "failure") assert.match(toResultJson(unknown.failure).error ?? "", /Unknown resumable subagent session/);

  // Original agent is unchanged: still has its original (queued) attempt.
  assert.equal(tracked.length, 1);
  assert.equal(spawn.agent.status.kind, "queued");
});
