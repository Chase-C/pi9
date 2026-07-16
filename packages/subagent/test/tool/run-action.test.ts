import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentExtension from "../../src/index.js";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { fakeAgent } from "../helpers/fake-agent.js";
import { renderWidgetContent } from "../helpers/render-widget.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";

const baseCtx = () => ({ cwd: process.cwd(), hasUI: false, modelRegistry: { getAll: () => [] } } as any);

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

/** The model-facing `results` array, parsed from a tool result's JSON content. */
const resultsJson = (r: any) => JSON.parse(r.content[0].text).results;

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

test("tool run action does not expose transient foreground ids as collectable result session ids", async () => {
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startRun() {
      const resultsPromise = Promise.resolve([fakeAgent({
        id: "transient-run-id",
        config: { name: "helper", resumable: false },
        prompt: "work",
        status: { kind: "completed", response: "done" },
      })]);
      return { sessions: [], resultsPromise };
    },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work", label: "helper work" }],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
  const rendered = tool.renderResult(result, { expanded: true }, { fg: (_color: string, text: string) => text }).render(120).join("\n");

  assert.equal(result.isError, false);
  assert.equal(resultsJson(result)[0].result.sessionId, undefined);
  assert.equal(resultsJson(result)[0].sessionId, undefined);
  assert.doesNotMatch(rendered, /session:transient-run-id/);
});

test("tool run action returns full output only once in JSON details for a resume task", async () => {
  const fullOutput = `resume output ${"q".repeat(1500)} tail`;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startRun(_ctx: any, _signal: any, tasks: any[]) {
      const resultsPromise = Promise.resolve(tasks.map((task: any) => fakeAgent({
        id: task.sessionId ?? "s1",
        config: { name: "helper", resumable: true },
        prompt: task.prompt,
        status: { kind: "completed", response: fullOutput, resumed: task.kind === "resume" },
      })));
      return { sessions: [], resultsPromise };
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
  assert.equal(resultsJson(result)[0].result.output, fullOutput);
  assert.equal((result.content[0].text.match(new RegExp(fullOutput, "g")) ?? []).length, 1);
});

test("tool execution returns structured failed run for unknown agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-unknown-"));
  const tool = registerExtension();

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "missing", prompt: "do work", label: "missing agent work" }],
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.equal(result.details.view, "results");
  const json = JSON.parse(result.content[0].text);
  assert.deepEqual(json.results.map((r: any) => r.result.agent), ["missing"]);
  assert.equal(json.results[0].result.status, "error");
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
      { agent: "helper", prompt: "first", label: "first task" },
      { agent: "missing", prompt: "second", label: "second task" },
      { agent: "flaky", prompt: "third", label: "third task" },
    ],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  const json = JSON.parse(result.content[0].text);
  assert.deepEqual(json.results.map((run: any) => run.result.agent), ["helper", "missing", "flaky"]);
  assert.equal(json.results[0].result.output, "done:first");
  assert.deepEqual(json.results.map((run: any) => run.result.status), ["completed", "error", "error"]);
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
    startRun(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], tree: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([fakeAgent({ id: "s1", config: { name: "helper" }, prompt: "work", status: { kind: "completed", response: "done" } })]);
      return { sessions: [runningAgent], resultsPromise };
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
    tasks: [{ agent: "helper", prompt: "work", label: "helper work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify: (...args: any[]) => notifications.push(args) },
  });

  assert.equal(result.isError, false);
  assert.equal(resultsJson(result)[0].result.output, "done");
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
    startRun(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], tree: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([fakeAgent({ id: "s1", config: { name: "helper" }, prompt: "work", status: { kind: "completed", response: "done" } })]);
      return { sessions: [runningAgent], resultsPromise };
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
    tasks: [{ agent: "helper", prompt: "work", label: "helper work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify: (...args: any[]) => notifications.push(args) },
  });

  assert.equal(result.isError, false);
  assert.equal(resultsJson(result)[0].result.output, "done");
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
    startRun(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], tree: [runningAgent], active: true });
      const resultsPromise = Promise.resolve([fakeAgent({ id: "s1", config: { name: "helper" }, prompt: "work", status: { kind: "completed", response: "done" } })]);
      return { sessions: [runningAgent], resultsPromise };
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
    tasks: [{ agent: "helper", prompt: "work", label: "helper work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(resultsJson(result)[0].result.output, "done");
  assert.equal(resultsJson(result)[0].result.agent, "helper");
  assert.ok(widgets.length > 0);
  assert.equal(widgets.every((call: any[]) => call[0] === "subagent" && call[1] === undefined), true);
});

test("subagent tool forwards live manager update tree to onUpdate and widget UI", async () => {
  const runningAgent = fakeAgent({
    id: "root",
    dispatch: "background",
    config: { name: "root" },
    status: { kind: "running", startedAt: 1 },
    message: "working",
    activeTools: ["read"],
    turns: 1,
    toolUses: 1,
  });
  const childAgent = fakeAgent({
    id: "child",
    parentSessionId: "root",
    dispatch: "background",
    config: { name: "child" },
    status: { kind: "running", startedAt: 1 },
    message: "child working",
    turns: 1,
  });
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  let managerSessions = [runningAgent, childAgent];
  const fakeManager = {
    listSessions(): any[] { return managerSessions; },
    sessions: [] as any[],
    startRun(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], tree: [runningAgent, childAgent], active: true });
      const resultsPromise = Promise.resolve().then(() => {
        managerSessions = [];
        return [fakeAgent({ id: "s1", config: { name: "helper" }, prompt: "work", status: { kind: "completed", response: "done" } })];
      });
      return { sessions: [runningAgent], resultsPromise };
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
    tasks: [{ agent: "helper", prompt: "work", label: "helper work" }],
  }, undefined, (partial: any) => partials.push(partial), {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(resultsJson(result)[0].result.output, "done");
  assert.equal(partials[0].details.sessions[0].activity.toolHistory.at(-1)?.name, "read");
  assert.doesNotMatch(partials[0].content[0].text, /working/);
  assert.equal(widgets[0][0], "subagent");
  const widgetLines = renderWidgetContent(widgets[0][1], undefined, 60);
  assert.equal(widgetLines[0], "Background · 2 running");
  assert.match(widgetLines[1], /root/);
  assert.match(widgetLines[2], /child/);
  assert.deepEqual(widgets.at(-1), ["subagent", undefined, { placement: "belowEditor" }]);
});

test("background run widget updates render the full manager inventory, not only the latest batch", async () => {
  const retained = fakeAgent({
    id: "retained",
    retention: "persistent",
    config: { name: "retained", resumable: true },
    createdAt: 1,
    status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ready" },
  });
  const oldBackground = fakeAgent({
    id: "old-bg",
    dispatch: "background",
    retention: "persistent",
    config: { name: "old-bg" },
    createdAt: 2,
    status: { kind: "completed", startedAt: 1, completedAt: 3, response: "done" },
  });
  const latestBackground = fakeAgent({
    id: "new-bg",
    dispatch: "background",
    retention: "persistent",
    config: { name: "new-bg" },
    createdAt: 3,
    status: { kind: "running", startedAt: 4 },
  });
  const allSessions = [retained, oldBackground, latestBackground];
  const fakeManager = {
    listSessions(): any[] { return allSessions; },
    startRun(_ctx: any, _signal: any, _tasks: any[], onUpdate: any) {
      onUpdate?.({ sessions: [latestBackground], tree: [latestBackground], active: true });
      return {
        sessions: [latestBackground],
        resultsPromise: new Promise<any[]>(() => {}),
      };
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
    settingsStore: { async load() { return { settings: { ...DEFAULT_SUBAGENT_SETTINGS, widgetLayout: "stacked" } }; } },
  });

  const widgets: any[] = [];
  const result = await tool.execute("tool-call", {
    action: "run",
    background: true,
    tasks: [{ agent: "helper", prompt: "background work", label: "background work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify() {} },
  });

  assert.equal(result.details.view, "background-started");
  const lines = renderWidgetContent(widgets.at(-1)[1], undefined, 80).join("\n");
  assert.match(lines, /Background · 1 running · 1 ready/);
  assert.match(lines, /new-bg/);
  assert.match(lines, /old-bg/);
  assert.match(lines, /Resumable · 1 ready/);
  assert.match(lines, /retained/);
});

test("foreground run widget updates also preserve background and retained sections while running", async () => {
  const background = fakeAgent({
    id: "bg",
    dispatch: "background",
    retention: "persistent",
    config: { name: "background" },
    createdAt: 1,
    status: { kind: "running", startedAt: 1 },
  });
  const retained = fakeAgent({
    id: "retained",
    retention: "persistent",
    config: { name: "retained", resumable: true },
    createdAt: 2,
    status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ready" },
  });
  const current = fakeAgent({
    id: "current",
    retention: "transient",
    config: { name: "current" },
    createdAt: 3,
    status: { kind: "running", startedAt: 3 },
  });
  let finish!: () => void;
  const fakeManager = {
    listSessions(): any[] { return [background, retained, current]; },
    startRun(_ctx: any, _signal: any, _tasks: any[], onUpdate: any) {
      Promise.resolve().then(() => onUpdate?.({ sessions: [current], tree: [current], active: true }));
      return {
        sessions: [current],
        resultsPromise: new Promise<any[]>(resolve => {
          finish = () => resolve([fakeAgent({ id: "current", config: { name: "current" }, status: { kind: "completed", response: "done" } })]);
        }),
      };
    },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map([["helper", { name: "helper", description: "Helps", source: "project" }]]), async reload() {}, summarizeAgent() { return "helper (project)"; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { ...DEFAULT_SUBAGENT_SETTINGS, widgetLayout: "stacked" } }; } },
  });

  const widgets: any[] = [];
  const execute = tool.execute("tool-call", {
    action: "run",
    tasks: [{ agent: "helper", prompt: "work", label: "foreground work" }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args: any[]) => widgets.push(args), notify() {} },
  });

  await new Promise(resolve => setImmediate(resolve));
  const liveLines = renderWidgetContent(widgets[0][1], undefined, 80).join("\n");
  assert.match(liveLines, /Background · 1 running/);
  assert.match(liveLines, /background/);
  assert.match(liveLines, /Resumable · 1 ready/);
  assert.match(liveLines, /retained/);
  assert.match(liveLines, /\+1 foreground running/);

  finish();
  await execute;
});

test("subagent action=run accepts a heterogeneous batch of spawn and resume tasks", async () => {
  let receivedTasks: any;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startRun(_ctx: any, _signal: any, tasks: any[]) {
      receivedTasks = tasks;
      const resultsPromise = Promise.resolve(tasks.map((task: any) => fakeAgent({
        id: task.kind === "resume" ? task.sessionId : "spawned",
        config: { name: task.kind === "spawn" ? task.agent : "chatty", resumable: task.kind === "resume" },
        prompt: task.prompt,
        status: { kind: "completed", response: `done:${task.prompt}`, resumed: task.kind === "resume" },
      })));
      return { sessions: [], resultsPromise };
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
      { agent: "helper", prompt: "one", label: "new helper" },
      { sessionId: "s-1", prompt: "two" },
    ],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.deepEqual(receivedTasks.map((t: any) => t.kind), ["spawn", "resume"]);
  assert.equal(receivedTasks[1].sessionId, "s-1");
  assert.equal(resultsJson(result)[0].result.resumed, false);
  assert.equal(resultsJson(result)[1].result.resumed, true);
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
    tasks: [{ agent: "helper", prompt: "background work", label: "background work" }],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.view, "background-started");
  assert.equal(result.details.count, 1);
  assert.equal(result.details.handles.length, 1);
  const handle = result.details.handles[0];
  assert.equal(typeof handle.sessionId, "string");
  assert.equal(handle.agent, "helper");
  assert.equal(handle.label, "background work");
  assert.deepEqual(Object.keys(handle).sort(), ["agent", "label", "sessionId"]);
  const liveStatus = manager.listSessions()[0].status.kind;
  assert.ok(liveStatus === "queued" || liveStatus === "running", `expected non-terminal status, got ${liveStatus}`);

  releaseRun!();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
});

test("background run reports preflight failures without hiding successful handles", async () => {
  const runner = async (_ctx: any, agent: any, attempt: any) => {
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return completedRun(agent, `done:${attempt.prompt}`);
  };
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", systemPrompt: "s", source: "project" }]]),
    async reload() {},
    summarizeAgent() { return "helper (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 2, runner);
  const allocator = (manager as any)._sessionIdAllocator;
  for (let i = 0; i < 100 * 100 - 1; i++) assert.ok(allocator.allocate());
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const result = await tool.execute("tool-call", {
    action: "run",
    background: true,
    tasks: [
      { agent: "helper", prompt: "successful task", label: "success" },
      { agent: "helper", prompt: "exhausted task", label: "exhausted" },
    ],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.equal(result.details.view, "background-started");
  assert.equal(result.details.count, 1);
  assert.equal(result.details.handles.length, 1);
  assert.equal(result.details.handles[0].label, "success");
  assert.deepEqual(result.details.errors, [{
    agent: "helper",
    label: "exhausted",
    error: "Subagent session ID space exhausted.",
  }]);

  const json = JSON.parse(result.content[0].text);
  assert.equal(json.count, 1);
  assert.equal(json.handles[0].label, "success");
  assert.deepEqual(json.errors, result.details.errors);
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
    tasks: [{ agent: "helper", prompt: "background work", label: "background work" }],
  }, undefined, onUpdate, baseCtx());

  await new Promise(resolve => setTimeout(resolve, 250));
  releaseRun!();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(onUpdateCalls, []);
});

test("subagent action=run rejects a non-boolean batch background without dispatching", async () => {
  let startCalls = 0;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startRun() { startCalls += 1; throw new Error("should not dispatch"); },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const result = await tool.execute("tool-call", {
    action: "run",
    background: "false",
    tasks: [{ agent: "helper", prompt: "p" }],
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.equal(startCalls, 0);
  assert.match(result.content[0].text, /run background must be a boolean/);
});

test("subagent action=results rejects a non-boolean remove flag without fetching or removing", async () => {
  let fetchCalls = 0;
  let removeCalls = 0;
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    backgroundResults() { fetchCalls += 1; return []; },
    async remove() { removeCalls += 1; },
  };
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const result = await tool.execute("tool-call", {
    action: "results",
    sessionIds: ["s1"],
    remove: "false",
  }, undefined, undefined, baseCtx());

  assert.equal(result.isError, true);
  assert.equal(fetchCalls, 0);
  assert.equal(removeCalls, 0);
  assert.match(result.content[0].text, /results remove must be a boolean/);
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

test("a late-arriving descendant status change triggers a partial re-emit with the descendant visible", async () => {
  const partials: any[] = [];
  const rootView = fakeAgent({ id: "root", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const grandView = fakeAgent({ id: "grand", parentSessionId: "root", config: { name: "grand" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });

  let resolveBatch!: () => void;
  let capturedListener: any;

  const fakeManager = {
    listSessions(): any[] { return [rootView, grandView]; },
    runner: { suspendAgentSlotDuring<T>(_id: string, fn: () => Promise<T>) { return fn(); } },
    startRun(_ctx: any, _signal: any, _tasks: any[], onUpdate: any) {
      capturedListener = onUpdate;
      const resultsPromise = new Promise<any[]>(resolve => {
        resolveBatch = () => resolve([fakeAgent({ id: "root", config: { name: "root" }, prompt: "go", status: { kind: "completed", response: "ok" } })]);
      });
      // Initial emit covers just the root (the descendant has not arrived yet).
      Promise.resolve().then(() => onUpdate({ sessions: [rootView], tree: [rootView], active: true }));
      return { sessions: [rootView], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const executePromise = tool.execute(
    "tool-call",
    { action: "run", tasks: [{ agent: "root", prompt: "go", label: "root work" }] },
    undefined,
    (partial: any) => partials.push(partial),
    baseCtx(),
  );

  await new Promise(r => setTimeout(r, 10));
  // Manager simulates the run group's later re-emit once the descendant arrives.
  capturedListener({ sessions: [rootView], tree: [rootView, grandView], active: true });

  await new Promise(r => setTimeout(r, 20));
  resolveBatch();
  await executePromise;

  const lastPartialWithSubtree = partials.filter(p => Array.isArray(p.details.subtree)).at(-1);
  assert.ok(lastPartialWithSubtree, "expected at least one partial with a subtree");
  assert.deepEqual(
    lastPartialWithSubtree.details.subtree.map((s: any) => s.id),
    ["root", "grand"],
  );
});

test("partial tool results carry the full descendant subtree; final results retain compact subagent data", async () => {
  const partials: any[] = [];
  const rootView = fakeAgent({ id: "root", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const childView = fakeAgent({ id: "child", parentSessionId: "root", config: { name: "child" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });

  const fakeManager = {
    listSessions(): any[] { return [rootView, childView]; },
    snapshotWithSubagents(snapshot: any) { return { ...snapshot, subagents: [childView] }; },
    runner: { suspendAgentSlotDuring<T>(_id: string, fn: () => Promise<T>) { return fn(); } },
    startRun(_ctx: any, _signal: any, _tasks: any[], onUpdate: any) {
      // Drive one partial update with the full tree, then resolve with the final root result.
      Promise.resolve().then(() => onUpdate({ sessions: [rootView], tree: [rootView, childView], active: true }));
      const resultsPromise = new Promise<any[]>(resolve => {
        setTimeout(() => resolve([fakeAgent({ id: "root", config: { name: "root" }, prompt: "go", status: { kind: "completed", response: "ok" } })]), 10);
      });
      return { sessions: [rootView], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const final = await tool.execute(
    "tool-call",
    { action: "run", tasks: [{ agent: "root", prompt: "go", label: "root work" }] },
    undefined,
    (partial: any) => partials.push(partial),
    baseCtx(),
  );

  assert.ok(partials.length >= 1, `expected at least one partial; got ${partials.length}`);
  const lastPartial = partials[partials.length - 1];
  assert.deepEqual(
    (lastPartial.details.subtree ?? []).map((s: any) => s.id),
    ["root", "child"],
  );

  // The final envelope remains root-oriented while renderer details retain child summaries.
  assert.equal(final.details.view, "results");
  assert.equal(final.details.subtree, undefined);
  assert.equal(final.details.sessions, undefined);
  assert.deepEqual(final.details.results[0].snapshot.subagents.map((s: any) => s.id), ["child"]);
  assert.deepEqual(resultsJson(final).map((o: any) => o.result.agent), ["root"]);
  assert.equal(resultsJson(final)[0].result.subagents, undefined);
});
