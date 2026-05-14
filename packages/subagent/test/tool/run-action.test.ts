import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentExtension from "../../src/index.js";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { completedRun } from "../../src/domain/agent-result.js";
import { fakeAgent } from "../helpers/fake-agent.js";

const baseCtx = () => ({ cwd: process.cwd(), hasUI: false, modelRegistry: { getAll: () => [] } } as any);

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("tool execution uses configured maxTasksPerRun from subagent settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-max-tasks-config-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "helper.md"), `---\nname: helper\ndescription: Helps\n---\nHelp prompt`);

  const tool = registerExtension({
    settingsStore: { load: async () => ({ settings: { widgetPlacement: "belowEditor", runtime: { maxTasksPerRun: 1 } } }) },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "task 1" }, { agent: "helper", prompt: "task 2" }],
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Too many tasks \(2\)\. Max is 1/);
});

test("tool run action returns full output only once in JSON details for a resume task", async () => {
  const fullOutput = `resume output ${"q".repeat(1500)} tail`;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, tasks: any[]) {
      const resultsPromise = Promise.resolve(tasks.map((task: any) => ({
        agent: "helper",
        prompt: task.prompt,
        status: "completed",
        output: fullOutput,
        sessionId: task.sessionId ?? "s1",
        resumable: true,
        resumed: task.kind === "resume",
      })));
      return { groupId: "g1", sessions: [], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ sessionId: "s1", prompt: "follow up" }],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, fullOutput);
  assert.equal((result.content[0].text.match(new RegExp(fullOutput, "g")) ?? []).length, 1);
});

test("tool execution returns structured failed run for unknown agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-unknown-"));
  const tool = registerExtension();

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "missing", prompt: "do work" }],
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details.results.map((r: any) => r.agent), ["missing"]);
  assert.equal(result.details.results[0].status, "error");
  assert.match(result.content[0].text, /"results"/);
});

test("subagent tool returns one ordered final group for mixed success, unknown, and failed children", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    if (agent.agentName === "flaky") throw new Error("flaky failed");
    return completedRun(agent, `done:${prompt}`);
  };
  const fakeRegistry = {
    agents: new Map([
      ["helper", { name: "helper", description: "Helps", systemPrompt: "s", source: "project" }],
      ["flaky", { name: "flaky", description: "Fails", systemPrompt: "s", source: "project" }],
    ]),
    async reload() {},
    summarizeAgent() { return "helper (project)\nflaky (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 2, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [
      { agent: "helper", prompt: "first" },
      { agent: "missing", prompt: "second" },
      { agent: "flaky", prompt: "third" },
    ],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.deepEqual(result.details.results.map((run: any) => run.agent), ["helper", "missing", "flaky"]);
  assert.equal(result.details.results[0].output, "done:first");
  assert.deepEqual(result.details.results.map((run: any) => run.status), ["completed", "error", "error"]);
  assert.deepEqual(result.details.group.sessions.map((s: any) => s.config.name), ["helper", "missing", "flaky"]);
  assert.deepEqual(result.details.group.sessions.map((s: any) => s.status.kind === "done" ? s.status.outcome : s.status.kind), ["completed", "error", "error"]);
  assert.equal(result.details.group.statusCounts.completed, 1);
  assert.equal(result.details.group.statusCounts.error, 2);
  assert.equal(result.details.group.isError, true);
});

test("subagent tool notifies invalid settings fallback without breaking execution", async () => {
  const runningAgent = fakeAgent({ status: { kind: "running", startedAt: 1 }, turns: 1 });
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([{ agent: "helper", prompt: "work", status: "completed", output: "done", sessionId: "s1", resumable: false, resumed: false }]);
      return { groupId: "g1", sessions: [runningAgent], resultsPromise };
    },
  };
  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" }, warning: "Invalid subagent UI settings." }; } },
  });

  const notifications: any[] = [];
  const widgets: any[] = [];
  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify: (...args: any[]) => notifications.push(args) },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, "done");
  assert.match(notifications[0][0], /Invalid subagent UI settings/);
  assert.equal(notifications[0][1], "warning");
  assert.deepEqual(widgets[0][2], { placement: "belowEditor" });
});

test("subagent tool falls back to default UI settings when settings load rejects", async () => {
  const runningAgent = fakeAgent({ status: { kind: "running", startedAt: 1 }, turns: 1 });
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([{ agent: "helper", prompt: "work", status: "completed", output: "done", sessionId: "s1", resumable: false, resumed: false }]);
      return { groupId: "g1", sessions: [runningAgent], resultsPromise };
    },
  };
  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { throw new Error("disk unreadable"); } },
  });

  const notifications: any[] = [];
  const widgets: any[] = [];
  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify: (...args: any[]) => notifications.push(args) },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, "done");
  assert.match(notifications[0][0], /Failed to load subagent UI settings/);
  assert.equal(notifications[0][1], "warning");
  assert.deepEqual(widgets[0][2], { placement: "belowEditor" });
});

test("subagent tool keeps subagent surfaces working but hides widget when placement is off", async () => {
  const runningAgent = fakeAgent({ status: { kind: "running", startedAt: 1 }, message: "working", turns: 1 });
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [runningAgent],
    startBatch(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([{ agent: "helper", prompt: "work", status: "completed", output: "done", sessionId: "s1", resumable: false, resumed: false }]);
      return { groupId: "g1", sessions: [runningAgent], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "off" } }; } },
  });

  const widgets: any[] = [];
  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, "done");
  assert.equal(result.details.group.sessions[0].config.name, "helper");
  assert.ok(widgets.length > 0);
  assert.equal(widgets.every((call: any[]) => call[0] === "subagent" && call[1] === undefined), true);
});

test("subagent tool forwards live manager updates to onUpdate and widget UI", async () => {
  const runningAgent = fakeAgent({
    status: { kind: "running", startedAt: 1 },
    message: "working",
    activeTools: ["read"],
    turns: 1,
    toolUses: 1,
  });
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([{ agent: "helper", prompt: "work", status: "completed", output: "done", sessionId: "s1", resumable: false, resumed: false }]);
      return { groupId: "g1", sessions: [runningAgent], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; }, async save() {} },
  });

  const partials: any[] = [];
  const widgets: any[] = [];
  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work" }],
  }, undefined, (partial: any) => partials.push(partial), {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, "done");
  assert.equal(result.details.group.sessions[0].activity.toolHistory.at(-1)?.name, "read");
  assert.equal(partials[0].details.group.sessions[0].activity.toolHistory.at(-1)?.name, "read");
  assert.doesNotMatch(partials[0].content[0].text, /working/);
  assert.equal(widgets[0][0], "subagent");
  assert.match(widgets[0][1][0], /helper/);
  assert.deepEqual(widgets.at(-1), ["subagent", undefined, { placement: "belowEditor" }]);
});

test("subagent action=run dispatches a spawn-only batch through agentManager.startBatch with resumed flags", async () => {
  let runCalls = 0;
  let receivedTasks: any;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, tasks: any[]) {
      runCalls += 1;
      receivedTasks = tasks;
      const resultsPromise = Promise.resolve(tasks.map((task: any) => ({
        agent: task.agent ?? "(unknown)",
        prompt: task.prompt,
        status: "completed",
        output: `done:${task.prompt}`,
        resumable: false,
        resumed: task.kind === "resume",
      })));
      return { groupId: "g1", sessions: [], resultsPromise };
    },
  };
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work" }],
  }, undefined, undefined, baseCtx());

  assert.equal(runCalls, 1);
  assert.equal(receivedTasks.length, 1);
  assert.equal(receivedTasks[0].kind, "spawn");
  assert.equal(receivedTasks[0].agent, "helper");
  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, "done:work");
  assert.equal(result.details.results[0].resumed, false);
});

test("subagent action=run accepts a heterogeneous batch of spawn and resume tasks", async () => {
  let receivedTasks: any;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startBatch(_ctx: any, _signal: any, tasks: any[]) {
      receivedTasks = tasks;
      const resultsPromise = Promise.resolve(tasks.map((task: any) => ({
        agent: task.kind === "spawn" ? task.agent : "chatty",
        prompt: task.prompt,
        status: "completed",
        output: `done:${task.prompt}`,
        resumable: task.kind === "resume",
        resumed: task.kind === "resume",
        ...(task.kind === "resume" ? { sessionId: task.sessionId } : {}),
      })));
      return { groupId: "g1", sessions: [], resultsPromise };
    },
  };
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const tool = registerExtension({
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [
      { agent: "helper", prompt: "one" },
      { sessionId: "s-1", prompt: "two" },
    ],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.deepEqual(receivedTasks.map((t: any) => t.kind), ["spawn", "resume"]);
  assert.equal(receivedTasks[1].sessionId, "s-1");
  assert.equal(result.details.results[0].resumed, false);
  assert.equal(result.details.results[1].resumed, true);
});

test("subagent action=run background:true returns view:background-started immediately with initial session views", async () => {
  let releaseRun: () => void;
  const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    await runGate;
    return completedRun(agent, `done:${prompt}`);
  };
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", systemPrompt: "s", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 2, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const result = await tool.execute("tool-call", {
    action: "run",
    background: true,
    tasks: [{ agent: "helper", prompt: "background work" }],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.view, "background-started");
  assert.equal(result.details.background, true);
  assert.equal(result.details.sessions.length, 1);
  assert.equal(result.details.sessions[0].kind, "background");
  const liveStatus = manager.listSessions()[0].status.kind;
  assert.ok(liveStatus === "queued" || liveStatus === "running", `expected non-terminal status, got ${liveStatus}`);

  releaseRun!();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
});

test("subagent action=run background:true never invokes the parent onUpdate channel", async () => {
  let releaseRun: () => void;
  const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
  const runner = async (_ctx: any, agent: any, attempt: any) => { const prompt = attempt.prompt;
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    await runGate;
    return completedRun(agent, `done:${prompt}`);
  };
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", systemPrompt: "s", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 2, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const onUpdateCalls: unknown[] = [];
  const onUpdate = (partial: unknown) => { onUpdateCalls.push(partial); };

  await tool.execute("tool-call", {
    action: "run",
    background: true,
    tasks: [{ agent: "helper", prompt: "background work" }],
  }, undefined, onUpdate, baseCtx());

  await new Promise(resolve => setTimeout(resolve, 250));
  releaseRun!();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(onUpdateCalls, []);
});

test("subagent action=run rejects a per-task background field with the batch-level migration error", async () => {
  let runCalls = 0;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    async run() { runCalls += 1; return []; },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "p", background: true }],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.equal(runCalls, 0);
  assert.match(result.content[0].text, /background is a batch-level flag on action='run', not a per-task field\./);
});

test("subagent action=run rejects a task carrying both agent and sessionId at parse time", async () => {
  let runCalls = 0;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    async run() { runCalls += 1; return []; },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", sessionId: "s", prompt: "p" }],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.equal(runCalls, 0);
  assert.match(result.content[0].text, /both agent and sessionId/);
});
