import { test } from "vitest";
import assert from "node:assert/strict";

import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import type { AgentViewStatus } from "../../src/domain/agent-snapshot.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { toResult } from "../../src/domain/agent-result.js";
import { resolveTask } from "../../src/runtime/task-resolution.js";

const noop: AgentUpdateListener = () => {};
const fakeSession = { subscribe: () => () => {}, abort: () => {} };
const view = (agent: Agent) => agent.snapshot();

function doneStatus(agent: Agent): Extract<AgentViewStatus, { kind: "done" }> {
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
 * Builds a single-agent registry plus a `findAgent` shim so task resolution can be exercised
 * directly. The returned `resolve` invokes the runtime resolver with sensible defaults — tests
 * pass the listener if they want to observe update emissions.
 */
function resolveScenario(opts: { config?: any } = {}) {
  const registry = {
    agents: new Map([[ (opts.config ?? baseConfig).name, opts.config ?? baseConfig ]]),
  } as any;
  const tracked: Agent[] = [];
  const findAgent = (id: string) => tracked.find(a => a.id === id);
  function resolve(task: any, listener: AgentUpdateListener = noop, background = false) {
    const result = resolveTask({
      task, background, groupId: "g", inputIndex: 0,
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

test("snapshot uses configured defaults when no task override is provided", () => {
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
    assert.equal(agent.shouldRetainConversation, override);
    assert.equal(view(agent).config.resumable, override);
  }
});

test("snapshot projects requested skills for defaults, overrides, and explicit disable", () => {
  const config = {
    ...baseConfig,
    model: "definition/model",
    thinking: "low" as const,
    tools: ["read", "grep"],
    skills: ["definition-skill"],
    resumable: false,
  };
  const defaults = new Agent("defaults", config, {
    kind: "spawn",
    agent: "helper",
    prompt: "work",
  }, noop);
  assert.deepEqual(defaults.requestedConfig.skills, ["definition-skill"]);
  assert.deepEqual(defaults.snapshot().config.skills, ["definition-skill"]);

  const override = new Agent("override", config, {
    kind: "spawn",
    agent: "helper",
    prompt: "work",
    model: "spawn/model",
    thinking: "high",
    skills: ["requested-skill"],
    cwd: "nested",
    resumable: true,
  }, noop);
  assert.deepEqual(override.requestedConfig, {
    model: "spawn/model",
    thinking: "high",
    skills: ["requested-skill"],
    tools: ["read", "grep"],
    cwd: "nested",
    resumable: true,
  });
  assert.equal(override.snapshot().status.kind, "queued");
  assert.deepEqual(override.snapshot().config.skills, ["requested-skill"]);
  override.attach(fakeSession as any);
  assert.equal(override.snapshot().status.kind, "running");
  assert.deepEqual(override.snapshot().config.skills, ["requested-skill"]);
  completedRun(override, "done");
  assert.equal(override.snapshot().status.kind, "done");
  assert.deepEqual(override.snapshot().config.skills, ["requested-skill"]);

  const disabled = new Agent("disabled", config, {
    kind: "spawn",
    agent: "helper",
    prompt: "work",
    skills: [],
  }, noop);
  assert.deepEqual(disabled.requestedConfig.skills, []);
  assert.deepEqual(disabled.snapshot().config.skills, []);
});

test("post-attach resumable overrides update the canonical policy and effective config", () => {
  const agent = new Agent("id", { ...baseConfig, resumable: true }, {
    kind: "spawn", agent: "helper", prompt: "first",
  }, noop);
  agent.setEffectiveConfig({ cwd: "/tmp", skills: [], tools: [], resumable: true });
  agent.attach(fakeSession as any);
  completedRun(agent, "first");

  agent.beginResume("follow-up", false, false);
  assert.equal(agent.requestedConfig.resumable, true, "queued override is not applied before attach");
  agent.attach(fakeSession as any);

  assert.equal(agent.requestedConfig.resumable, false);
  assert.equal(agent.resumableEnabled, false);
  assert.equal(agent.snapshot().effectiveConfig?.resumable, false);
  assert.equal(agent.snapshot().config.resumable, false);
});

test("task resolution keeps the stored label when omitted on resume and overwrites it when provided", () => {
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
  completedRun(r1.agent, "done again");

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

test("task resolution re-subscribes the session on resume so events during a resumed cycle update its state", () => {
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
  // Each attempt now carries isolated activity: the resume's current activity reflects only its
  // own events, while the completed spawn attempt is retained as a previous run section.
  const resumedSnapshot = view(agent);
  assert.equal(resumedSnapshot.activity.turns, 1);
  assert.equal(resumedSnapshot.activity.toolHistory.length, 1);
  assert.equal(resumedSnapshot.previousRuns?.length, 1);
  assert.equal(resumedSnapshot.previousRuns?.[0].activity.turns, 1);
  completedRun(agent, "done2");
  assert.equal(emit, undefined, "subscription should be torn down on complete after resume");
});

test("snapshot exposes a completed prior attempt as an isolated previous run section after resume", () => {
  let emit: ((event: any) => void) | undefined;
  const session = {
    messages: [],
    subscribe(handler: any) { emit = handler; return () => { emit = undefined; }; },
    prompt: async () => { },
    abort: () => { },
  };
  const { resolve } = resolveScenario({ config: { ...baseConfig, resumable: true, name: "a" } });
  const spawn = resolve({ kind: "spawn", agent: "a", prompt: "first prompt" });
  if (spawn.kind !== "spawn") throw new Error("expected spawn");
  const agent = spawn.agent;

  agent.attach(session as any);
  emit!({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.ts" } });
  emit!({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false });
  completedRun(agent, "first output");

  const resumed = resolve({ kind: "resume", sessionId: agent.id, prompt: "second prompt" });
  if (resumed.kind !== "resume") throw new Error("expected resume");
  agent.attach(session as any);
  emit!({ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: "b.ts" } });

  const snap = view(agent);
  // The current run's activity is isolated to the resume attempt.
  assert.deepEqual(snap.activity.toolHistory.map(t => t.name), ["edit"]);
  assert.equal(snap.prompt, "second prompt");

  // The completed spawn attempt is preserved as a single previous run section.
  assert.equal(snap.previousRuns?.length, 1);
  const prev = snap.previousRuns![0];
  assert.equal(prev.prompt, "first prompt");
  assert.equal(prev.status.kind, "done");
  if (prev.status.kind === "done") {
    assert.equal(prev.status.outcome, "completed");
    assert.equal(prev.status.output, "first output");
  }
  assert.deepEqual(prev.activity.toolHistory.map(t => t.name), ["read"]);
});

test("a single-run agent omits previousRuns from its snapshot", () => {
  const session = { messages: [], subscribe: () => () => { }, prompt: async () => { }, abort: () => { } };
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  // Queued, then running, then completed: none of these states should expose a previous run.
  assert.equal(view(agent).previousRuns, undefined);
  agent.attach(session as any);
  assert.equal(view(agent).previousRuns, undefined);
  completedRun(agent, "done");
  assert.equal(Object.prototype.hasOwnProperty.call(view(agent), "previousRuns"), false);
});

test("multiple resumes accumulate previous run sections in chronological order above the current run", () => {
  const session = {
    messages: [],
    subscribe: () => () => { },
    prompt: async () => { },
    abort: () => { },
  };
  const { resolve } = resolveScenario({ config: { ...baseConfig, resumable: true, name: "a" } });
  const spawn = resolve({ kind: "spawn", agent: "a", prompt: "run one" });
  if (spawn.kind !== "spawn") throw new Error("expected spawn");
  const agent = spawn.agent;

  agent.attach(session as any);
  completedRun(agent, "output one");

  const r1 = resolve({ kind: "resume", sessionId: agent.id, prompt: "run two" });
  if (r1.kind !== "resume") throw new Error("expected resume");
  agent.attach(session as any);
  completedRun(agent, "output two");

  const r2 = resolve({ kind: "resume", sessionId: agent.id, prompt: "run three" });
  if (r2.kind !== "resume") throw new Error("expected resume");
  agent.attach(session as any);

  const snap = view(agent);
  assert.equal(snap.prompt, "run three");
  assert.deepEqual(snap.previousRuns?.map(run => run.prompt), ["run one", "run two"]);
  assert.deepEqual(
    snap.previousRuns?.map(run => (run.status.kind === "done" ? run.status.output : undefined)),
    ["output one", "output two"],
  );
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

test("agent stores compact input summaries for known tool starts", () => {
  let sessionEmit: ((event: any) => void) | undefined;
  const session = {
    messages: [],
    subscribe(handler: any) { sessionEmit = handler; return () => { sessionEmit = undefined; }; },
    prompt: async () => { },
    abort: () => { },
  };
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "a", prompt: "p" }, noop);

  agent.attach(session as any);
  assert.ok(sessionEmit);
  sessionEmit({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "src/index.ts", offset: 10, limit: 5 } });
  sessionEmit({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "src/index.ts", edits: [{}, {}] } });
  sessionEmit({ type: "tool_execution_start", toolCallId: "bash", toolName: "bash", args: { command: "npm test \\\n -- --runInBand" } });
  sessionEmit({ type: "tool_execution_start", toolCallId: "sub", toolName: "subagent", args: { action: "run", tasks: [{}, {}] } });

  assert.deepEqual(view(agent).activity.toolHistory.map(tool => tool.inputSummary), [
    "src/index.ts offset 10 limit 5",
    "src/index.ts 2 edits",
    "npm test -- --runInBand",
    "run 2 tasks",
  ]);
});

test("input summaries cover path/pattern tools and fall back to scalar args for unknown tools", () => {
  let sessionEmit: ((event: any) => void) | undefined;
  const session = {
    messages: [],
    subscribe(handler: any) { sessionEmit = handler; return () => { sessionEmit = undefined; }; },
    prompt: async () => { },
    abort: () => { },
  };
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "a", prompt: "p" }, noop);

  agent.attach(session as any);
  assert.ok(sessionEmit);
  sessionEmit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "out.ts", content: "x" } });
  sessionEmit({ type: "tool_execution_start", toolCallId: "ls", toolName: "ls", args: { path: "packages/subagent" } });
  sessionEmit({ type: "tool_execution_start", toolCallId: "grep", toolName: "grep", args: { pattern: "TODO", path: "src" } });
  sessionEmit({ type: "tool_execution_start", toolCallId: "find", toolName: "find", args: { pattern: "*.ts", path: "src" } });
  sessionEmit({ type: "tool_execution_start", toolCallId: "custom", toolName: "weather", args: { city: "Paris", units: "metric", verbose: true } });
  sessionEmit({ type: "tool_execution_start", toolCallId: "empty", toolName: "mystery", args: {} });

  assert.deepEqual(view(agent).activity.toolHistory.map(tool => tool.inputSummary), [
    "out.ts",
    "packages/subagent",
    '"TODO" in src',
    "*.ts in src",
    "city:Paris units:metric verbose:true",
    undefined,
  ]);
});

test("Agent.abort on a running agent aborts the underlying session and finalizes as aborted", async () => {
  let abortCalls = 0;
  const session = { messages: [], subscribe: () => () => { }, prompt: async () => { }, abort: () => { abortCalls += 1; } };
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(session as any);

  await agent.abort();

  assert.equal(abortCalls, 1);
  assert.equal(doneStatus(agent).outcome, "aborted");
});

test("Agent.abort on a queued agent finalizes as skipped without touching a session", async () => {
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  assert.equal(agent.status.kind, "queued");

  await agent.abort();

  assert.equal(doneStatus(agent).outcome, "skipped");
});

test("Agent.abort on a terminal agent is a no-op and does not re-finalize", async () => {
  let abortCalls = 0;
  const session = { messages: [], subscribe: () => () => { }, prompt: async () => { }, abort: () => { abortCalls += 1; } };
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "p" }, noop);
  agent.attach(session as any);
  completedRun(agent, "done");
  const settled = doneStatus(agent);

  await agent.abort();

  assert.equal(abortCalls, 0);
  assert.deepEqual(doneStatus(agent), settled);
});

test("task resolution for an unknown agent returns a preflight failure with a helpful error", () => {
  const registry = { agents: new Map() } as any;
  const result = resolveTask({
    task: { kind: "spawn", agent: "missing", prompt: "p" },
    background: false,
    groupId: "g",
    inputIndex: 0,
    registry,
    findAgent: () => undefined,
    listener: noop,
  });

  assert.equal(result.kind, "failure");
  if (result.kind !== "failure") return;
  assert.match(toResult(result.failure).error ?? "", /Unknown agent: missing/);
  assert.equal(result.failure.config.source, undefined);
  assert.equal(result.failure.status.kind, "done");
});

test("task resolution explains that a completed non-resumable session cannot accept follow-ups", () => {
  const { resolve } = resolveScenario();
  const spawn = resolve({ kind: "spawn", agent: "helper", prompt: "work" });
  if (spawn.kind !== "spawn") throw new Error("expected spawn");
  spawn.agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} } as any);
  completedRun(spawn.agent, "done");

  const resumed = resolve({ kind: "resume", sessionId: spawn.agent.id, prompt: "follow up" });

  assert.equal(resumed.kind, "failure");
  if (resumed.kind === "failure") {
    assert.match(toResult(resumed.failure).error ?? "", /created with resumable: false/);
  }
});

test("task resolution rejects sessions that are mid-attempt or non-resumable, leaving the existing attempt intact", () => {
  const { resolve, tracked } = resolveScenario({ config: { ...baseConfig, source: "user", resumable: true } });
  const spawn = resolve({ kind: "spawn", agent: "helper", prompt: "work" });
  if (spawn.kind !== "spawn") throw new Error("expected spawn");

  // Attempt resume while the original spawn is still queued (mid-attempt) — should fail.
  const midAttempt = resolve({ kind: "resume", sessionId: spawn.agent.id, prompt: "queue jump" });
  assert.equal(midAttempt.kind, "failure");
  if (midAttempt.kind === "failure") {
    assert.match(toResult(midAttempt.failure).error ?? "", /already.*resum|while it is/i);
    assert.equal(midAttempt.failure.config.source, "user");
  }

  // Unknown session id surfaces a dedicated message.
  const unknown = resolve({ kind: "resume", sessionId: "no-such-id", prompt: "ghost" });
  assert.equal(unknown.kind, "failure");
  if (unknown.kind === "failure") assert.match(toResult(unknown.failure).error ?? "", /Unknown resumable subagent session/);

  // Original agent is unchanged: still has its original (queued) attempt.
  assert.equal(tracked.length, 1);
  assert.equal(spawn.agent.status.kind, "queued");
});
