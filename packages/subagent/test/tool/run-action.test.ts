import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentExtension from "../../src/index.js";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
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
    startRun(_ctx: any, _signal: any, tasks: any[]) {
      const resultsPromise = Promise.resolve(tasks.map((task: any) => fakeAgent({
        id: task.sessionId ?? "s1",
        config: { name: "helper", resumable: true },
        prompt: task.prompt,
        status: { kind: "completed", response: fullOutput, resumed: task.kind === "resume" },
      })));
      return { groupId: "g1", sessions: [], tree: () => [], resultsPromise };
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
  assert.equal(result.details.outcomes[0].output, fullOutput);
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
  assert.equal(result.details.view, "run-results");
  assert.deepEqual(result.details.outcomes.map((r: any) => r.agent), ["missing"]);
  assert.equal(result.details.outcomes[0].status, "error");
  assert.match(result.content[0].text, /"outcomes"/);
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
  assert.deepEqual(result.details.outcomes.map((run: any) => run.agent), ["helper", "missing", "flaky"]);
  assert.equal(result.details.outcomes[0].output, "done:first");
  assert.deepEqual(result.details.outcomes.map((run: any) => run.status), ["completed", "error", "error"]);
  assert.equal(result.details.isError, true);
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
      return { groupId: "g1", sessions: [runningAgent], tree: () => [runningAgent], resultsPromise };
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
  assert.equal(result.details.outcomes[0].output, "done");
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
      return { groupId: "g1", sessions: [runningAgent], tree: () => [runningAgent], resultsPromise };
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
  assert.equal(result.details.outcomes[0].output, "done");
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
      return { groupId: "g1", sessions: [runningAgent], tree: () => [runningAgent], resultsPromise };
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
  assert.equal(result.details.outcomes[0].output, "done");
  assert.equal(result.details.outcomes[0].agent, "helper");
  assert.ok(widgets.length > 0);
  assert.equal(widgets.every((call: any[]) => call[0] === "subagent" && call[1] === undefined), true);
});

test("subagent tool forwards live manager update tree to onUpdate and widget UI", async () => {
  const runningAgent = fakeAgent({
    id: "root",
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
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [] as any[],
    startRun(_ctx: any, _signal: any, _tasks: any, onUpdate: any) {
      onUpdate?.({ sessions: [runningAgent], tree: [runningAgent, childAgent], active: true });
      const resultsPromise = Promise.resolve([fakeAgent({ id: "s1", config: { name: "helper" }, prompt: "work", status: { kind: "completed", response: "done" } })]);
      return { groupId: "g1", sessions: [runningAgent], tree: () => [runningAgent, childAgent], resultsPromise };
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
  assert.equal(result.details.outcomes[0].output, "done");
  assert.equal(partials[0].details.group.sessions[0].activity.toolHistory.at(-1)?.name, "read");
  assert.doesNotMatch(partials[0].content[0].text, /working/);
  assert.equal(widgets[0][0], "subagent");
  assert.match(widgets[0][1][0], /root/);
  assert.match(widgets[0][1][1], /^  child/);
  assert.deepEqual(widgets.at(-1), ["subagent", undefined, { placement: "belowEditor" }]);
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
      return { groupId: "g1", sessions: [], tree: () => [], resultsPromise };
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
  assert.equal(result.details.outcomes[0].resumed, false);
  assert.equal(result.details.outcomes[1].resumed, true);
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
  assert.equal(result.details.count, 1);
  assert.equal(result.details.handles.length, 1);
  const handle = result.details.handles[0];
  assert.equal(typeof handle.sessionId, "string");
  assert.equal(handle.inputIndex, 0);
  assert.deepEqual(Object.keys(handle).sort(), ["inputIndex", "sessionId"]);
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
      return { groupId: "g1", sessions: [rootView], tree: () => [rootView, grandView], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const executePromise = tool.execute(
    "tool-call",
    { action: "run", tasks: [{ agent: "root", prompt: "go" }] },
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

test("partial tool results carry the full descendant subtree; final tool result stays flat", async () => {
  const partials: any[] = [];
  const rootView = fakeAgent({ id: "root", config: { name: "root" }, createdAt: 1, status: { kind: "running", startedAt: 1 } });
  const childView = fakeAgent({ id: "child", parentSessionId: "root", config: { name: "child" }, createdAt: 2, status: { kind: "running", startedAt: 1 } });

  const fakeManager = {
    listSessions(): any[] { return [rootView, childView]; },
    runner: { suspendAgentSlotDuring<T>(_id: string, fn: () => Promise<T>) { return fn(); } },
    startRun(_ctx: any, _signal: any, _tasks: any[], onUpdate: any) {
      // Drive one partial update with the full tree, then resolve with the final flat result.
      Promise.resolve().then(() => onUpdate({ sessions: [rootView], tree: [rootView, childView], active: true }));
      const resultsPromise = new Promise<any[]>(resolve => {
        setTimeout(() => resolve([fakeAgent({ id: "root", config: { name: "root" }, prompt: "go", status: { kind: "completed", response: "ok" } })]), 10);
      });
      return { groupId: "g1", sessions: [rootView], tree: () => [rootView, childView], resultsPromise };
    },
  };

  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; } },
  });

  const final = await tool.execute(
    "tool-call",
    { action: "run", tasks: [{ agent: "root", prompt: "go" }] },
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

  // Final result is the slim outcomes view; no subtree, no per-session AgentSnapshot dump
  assert.equal(final.details.view, "run-results");
  assert.equal(final.details.subtree, undefined);
  assert.equal(final.details.group, undefined);
  assert.deepEqual(final.details.outcomes.map((o: any) => o.agent), ["root"]);
});
