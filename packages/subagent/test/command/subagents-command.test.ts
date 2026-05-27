import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";
import { fakeAgent } from "../helpers/fake-agent.js";

const passthroughTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function registerCommand(dependencies: any = {}) {
  const commands = new Map<string, any>();
  subagentExtension({
    registerTool() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer() {},
    on: (event: string, handler: any) => dependencies.__events?.set(event, handler),
    sendMessage: (message: any, options?: any) => dependencies.__sentMessages?.push({ message, options }),
  } as any, dependencies);
  return commands;
}

test("/subagents settings exposes placement values, saves changes, and updates active widget", async () => {
  const runningSession = fakeAgent({ status: { kind: "running", startedAt: 1 }, turns: 1 });
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [runningSession],
  };
  let current = "belowEditor";
  const saved: any[] = [];
  const fakeSettingsStore = {
    async load() { return { settings: { widgetPlacement: current } }; },
    async save(settings: any) { current = settings.widgetPlacement; saved.push(settings); },
  };
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: fakeSettingsStore,
  });

  let rendered = "";
  const widgets: any[] = [];
  await commands.get("subagents").handler("settings", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget: (...args: any[]) => widgets.push(args),
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        rendered = component.render(120).join("\n");
        component.handleInput("\r");
        return Promise.resolve(undefined);
      },
    },
  });

  assert.match(rendered, /Subagent Settings/);
  assert.match(rendered, /Widget placement/);
  assert.match(rendered, /belowEditor/);
  assert.match(rendered, /Values: belowEditor, aboveEditor, off/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].widgetPlacement, "aboveEditor");
  assert.equal(saved[0].runtime.maxTasksPerRun, 8);
  assert.equal(widgets.at(-1)[0], "subagent");
  assert.deepEqual(widgets.at(-1)[2], { placement: "aboveEditor" });
});

test("/subagents settings exposes backgroundNotify with auto, steer, none and persists the chosen value", async () => {
  const fakeManager = { listSessions(): any[] { return []; } };
  const saved: any[] = [];
  const fakeSettingsStore = {
    async load() { return { settings: { widgetPlacement: "belowEditor", runtime: { backgroundNotify: "auto" } } }; },
    async save(settings: any) { saved.push(settings); },
  };
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: fakeSettingsStore,
  });

  let renderedInitial = "";
  let renderedOnBackgroundNotify = "";
  await commands.get("subagents").handler("settings", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget() {},
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        renderedInitial = component.render(120).join("\n");
        component.handleInput("\x1b[B"); // down to widgetLayout
        component.handleInput("\x1b[B"); // down to backgroundNotify
        renderedOnBackgroundNotify = component.render(120).join("\n");
        component.handleInput("\r"); // cycle auto -> steer
        return Promise.resolve(undefined);
      },
    },
  });

  assert.match(renderedInitial, /Background notify/);
  assert.match(renderedOnBackgroundNotify, /Values: auto, steer, none/);
  const last = saved.at(-1);
  assert.ok(last, "expected at least one save");
  assert.equal(last.runtime.backgroundNotify, "steer");
});

test("/subagents settings exposes widgetLayout with auto, columns, stacked and persists the chosen value", async () => {
  const runningSession = fakeAgent({ status: { kind: "running", startedAt: 1 }, turns: 1 });
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [runningSession],
  };
  const saved: any[] = [];
  const fakeSettingsStore = {
    async load() { return { settings: { widgetPlacement: "belowEditor", widgetLayout: "auto" } }; },
    async save(settings: any) { saved.push(settings); },
  };
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: fakeSettingsStore,
  });

  let renderedInitial = "";
  let renderedOnWidgetLayout = "";
  await commands.get("subagents").handler("settings", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget() {},
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        renderedInitial = component.render(120).join("\n");
        component.handleInput("\x1b[B"); // down to widgetLayout
        renderedOnWidgetLayout = component.render(120).join("\n");
        component.handleInput("\r"); // cycle auto -> columns
        return Promise.resolve(undefined);
      },
    },
  });

  assert.match(renderedInitial, /Widget layout/);
  assert.match(renderedOnWidgetLayout, /Values: auto, columns, stacked/);
  const last = saved.at(-1);
  assert.ok(last, "expected at least one save");
  assert.equal(last.widgetLayout, "columns");
});

test("/subagents settings backgroundNotify changes update live notifier mode immediately", async () => {
  let agentUpdate: ((agent: any, kind: string) => void) | undefined;
  const fakeManager = {
    listSessions(): any[] { return []; },
    onAgentUpdate(listener: any) { agentUpdate = listener; return () => {}; },
  };
  const fakeSettingsStore = {
    async load() { return { settings: { widgetPlacement: "belowEditor", runtime: { backgroundNotify: "auto" } } }; },
    async save() {},
  };
  const events = new Map<string, any>();
  const sentMessages: any[] = [];
  const commands = registerCommand({
    __events: events,
    __sentMessages: sentMessages,
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: fakeSettingsStore,
  });

  await commands.get("subagents").handler("settings", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget() {},
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        component.handleInput("\x1b[B"); // down to widgetLayout
        component.handleInput("\x1b[B"); // down to backgroundNotify
        component.handleInput("\r"); // auto -> steer
        component.handleInput("\r"); // steer -> none
        return Promise.resolve(undefined);
      },
    },
  });

  assert.equal(typeof agentUpdate, "function");
  agentUpdate!({
    id: "s1",
    agentName: "helper",
    background: true,
    createdAt: 1,
    status: { kind: "completed", startedAt: 1, completedAt: 2, result: { status: "completed" } },
  }, "status");
  events.get("agent_end")?.({});

  assert.deepEqual(sentMessages, []);
});

test("/subagents settings persists the latest rapid placement change before command completion", async () => {
  const runningSession = fakeAgent({ status: { kind: "running", startedAt: 1 }, turns: 1 });
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [runningSession],
  };
  let persisted = "belowEditor";
  let releaseFirstSave: (() => void) | undefined;
  const fakeSettingsStore = {
    async load() { return { settings: { widgetPlacement: persisted } }; },
    save(settings: any) {
      if (settings.widgetPlacement === "aboveEditor") {
        return new Promise<void>(resolve => {
          releaseFirstSave = () => { persisted = settings.widgetPlacement; resolve(); };
        });
      }
      persisted = settings.widgetPlacement;
      return Promise.resolve();
    },
  };
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore: fakeSettingsStore,
  });

  const widgets: any[] = [];
  const handlerPromise = commands.get("subagents").handler("settings", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget: (...args: any[]) => widgets.push(args),
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        component.handleInput("\r");
        component.handleInput("\r");
        return Promise.resolve(undefined);
      },
    },
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(widgets.at(-1)[0], "subagent");
  assert.equal(widgets.at(-1)[1], undefined);

  assert.equal(typeof releaseFirstSave, "function");
  releaseFirstSave!();
  await handlerPromise;

  assert.equal(persisted, "off");
});

test("/subagents settings closes through injected cancel keybindings", async () => {
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: { sessions: [], listSessions() { return this.sessions; } },
    settingsStore: { async load() { return { settings: { widgetPlacement: "belowEditor" } }; }, async save() {} },
  });

  let closed = false;
  await commands.get("subagents").handler("settings", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory: any) {
        return new Promise<void>(resolve => {
          const keybindings = { matches: (data: string, id: string) => data === "q" && id === "tui.select.cancel" };
          const component = factory({ requestRender() {} }, passthroughTheme, keybindings, () => {
            closed = true;
            resolve();
          });
          component.handleInput("q");
          setImmediate(() => { if (!closed) resolve(); });
        });
      },
    },
  });

  assert.equal(closed, true);
});

test("/subagents settings accepts j/k navigation like the other subagents views", async () => {
  const saved: any[] = [];
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: { sessions: [], listSessions() { return this.sessions; } },
    settingsStore: {
      async load() { return { settings: { widgetPlacement: "belowEditor", widgetLayout: "auto" } }; },
      async save(settings: any) { saved.push(settings); },
    },
  });

  await commands.get("subagents").handler("settings", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget() {},
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        component.handleInput("j"); // widgetPlacement -> widgetLayout
        component.handleInput("\r"); // auto -> columns
        return Promise.resolve(undefined);
      },
    },
  });

  const last = saved.at(-1);
  assert.ok(last, "expected settings to save");
  assert.equal(last.widgetLayout, "columns");
});

test("/subagents sessions view can open settings", async () => {
  const session = fakeAgent({ status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } });
  const saved: any[] = [];
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: { sessions: [session], listSessions() { return this.sessions; } },
    settingsStore: {
      async load() { return { settings: { widgetPlacement: "belowEditor" } }; },
      async save(settings: any) { saved.push(settings); },
    },
  });

  let customCalls = 0;
  let sessionsText = "";
  await commands.get("subagents").handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget() {},
      custom(factory: any) {
        customCalls += 1;
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        if (customCalls === 1) {
          sessionsText = component.render(120).join("\n");
          component.handleInput("s");
          return Promise.resolve({ action: "settings" });
        }
        component.handleInput("\r");
        return Promise.resolve(undefined);
      },
    },
  });

  assert.match(sessionsText, /Subagent Sessions/);
  assert.match(sessionsText, /s settings/);
  assert.equal(customCalls, 2);
  assert.equal(saved.at(-1).widgetPlacement, "aboveEditor");
});

test("/subagents can switch between sessions and agents views", async () => {
  const reloadCalls: string[] = [];
  const commands = registerCommand({
    agentRegistry: {
      agents: new Map([["helper", { name: "helper", description: "Helps", source: "project", resumable: false }]]),
      async reload(cwd: string) { reloadCalls.push(cwd); },
      summarizeAgent() { return ""; },
    },
    agentManager: {
      sessions: [fakeAgent({ status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" } })],
      listSessions() { return this.sessions; },
    },
  });

  const renders: string[] = [];
  let customCalls = 0;
  await commands.get("subagents").handler("", {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify() {},
      custom(factory: any) {
        customCalls += 1;
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        renders.push(component.render(120).join("\n"));
        if (customCalls === 1) {
          component.handleInput("\t");
          return Promise.resolve({ action: "agents" });
        }
        if (customCalls === 2) {
          component.handleInput("\t");
          return Promise.resolve({ action: "sessions" });
        }
        return Promise.resolve(undefined);
      },
    },
  });

  assert.match(renders[0], /Subagent Sessions/);
  assert.match(renders[0], /tab agents/);
  assert.match(renders[1], /Subagent Agents/);
  assert.match(renders[1], /tab sessions/);
  assert.match(renders[2], /Subagent Sessions/);
  assert.deepEqual(reloadCalls, ["/repo"]);
});

test("/subagents command is a silent no-op without UI, regardless of whether a notify is supplied", async () => {
  const fakeRegistry = {
    agents: new Map([["helper", { name: "helper", description: "Helps", source: "project", resumable: false }]]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const commands = registerCommand({ agentRegistry: fakeRegistry, agentManager: { listSessions: () => [], sessions: [] } });

  // No UI object at all: must not throw.
  await assert.doesNotReject(() => commands.get("subagents").handler("", { cwd: process.cwd(), hasUI: false }));

  // notify supplied but hasUI=false: must not be called.
  let notifyCalls = 0;
  await commands.get("subagents").handler("", { cwd: process.cwd(), hasUI: false, ui: { notify() { notifyCalls += 1; } } });
  assert.equal(notifyCalls, 0);
});

test("subagents command opens agents browser by default when sessions are empty", async () => {
  const reloadCalls: string[] = [];
  const fakeRegistry = {
    agents: new Map([
      ["helper", { name: "helper", description: "Helps with implementation", source: "project", resumable: true, model: "test/model", thinking: "high", tools: ["read", "bash"], sourcePath: "/repo/.pi/agents/helper.md" }],
      ["reviewer", { name: "reviewer", description: "Reviews changes", source: "user", resumable: false }],
    ]),
    async reload(cwd: string) { reloadCalls.push(cwd); },
    summarizeAgent() { return ""; },
  };
  const commands = registerCommand({ agentRegistry: fakeRegistry, agentManager: { listSessions: () => [], sessions: [] } });

  let listText = "";
  let inspectText = "";
  await commands.get("subagents").handler("", {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify() {},
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        listText = component.render(120).join("\n");
        component.handleInput("\r");
        inspectText = component.render(120).join("\n");
        return Promise.resolve(undefined);
      },
    },
  });

  assert.deepEqual(reloadCalls, ["/repo"]);
  assert.match(listText, /Subagent Agents/);
  assert.match(listText, /helper/);
  assert.match(listText, /Helps with implementation/);
  assert.match(listText, /project/);
  assert.match(listText, /resumable/);
  assert.match(listText, /reviewer/);
  assert.match(listText, /settings/);
  assert.match(listText, /close/);
  assert.doesNotMatch(listText, /launch|start/i);
  assert.match(inspectText, /Agent Definition/);
  assert.match(inspectText, /Name: helper/);
  assert.match(inspectText, /Description: Helps with implementation/);
  assert.match(inspectText, /Source: project/);
  assert.match(inspectText, /Model: test\/model/);
  assert.match(inspectText, /Thinking: high/);
  assert.match(inspectText, /Tools: read, bash/);
  assert.match(inspectText, /Resumable: true/);
  assert.match(inspectText, /Path: \/repo\/\.pi\/agents\/helper\.md/);
  assert.doesNotMatch(inspectText, /launch|start/i);
});

test("/subagents agents menu closes on a terminal escape sequence", async () => {
  const commands = registerCommand({
    agentRegistry: {
      agents: new Map([["helper", { name: "helper", description: "Helps", source: "project", resumable: false }]]),
      async reload() {},
      summarizeAgent() { return ""; },
    },
    agentManager: { sessions: [], listSessions() { return this.sessions; } },
  });

  let closed = false;
  await commands.get("subagents").handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory: any) {
        return new Promise<void>(resolve => {
          const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {
            closed = true;
            resolve();
          });
          component.handleInput("\x1b[27u");
          setImmediate(() => { if (!closed) resolve(); });
        });
      },
    },
  });

  assert.equal(closed, true);
});

test("/subagents sessions menu closes on a terminal escape sequence", async () => {
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: {
      listSessions(): any[] { return this.sessions; },
      sessions: [fakeAgent({ status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" }, turns: 1 })],
    },
  });

  let closed = false;
  await commands.get("subagents").handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory: any) {
        return new Promise<void>(resolve => {
          const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {
            closed = true;
            resolve();
          });
          component.handleInput("\x1b[27u");
          setImmediate(() => { if (!closed) resolve(); });
        });
      },
    },
  });

  assert.equal(closed, true);
});

test("/subagents sessions command uses configured display lengths for notification and inspect views", async () => {
  const session = fakeAgent({
    config: { resumable: true },
    status: { kind: "error", startedAt: 1, completedAt: 2, error: "abcdefghijklmnopqrstuvwxyz" },
    message: "0123456789abcdefghijklmnopqrstuvwxyz",
  });
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [session],
    configure() {},
  };
  const settingsStore = {
    async load() {
      return { settings: { display: { outputSnippetLength: 6, messageSnippetLength: 5 } } };
    },
  };
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    settingsStore,
  });

  const notifications: any[] = [];
  await commands.get("subagents").handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: { notify: (...args: any[]) => notifications.push(args) },
  });

  assert.match(notifications.at(-1)[0], /"0123…"/);
  assert.match(notifications.at(-1)[0], /outcome:error:abcde…/);
  assert.doesNotMatch(notifications.at(-1)[0], /abcdefghijklmnopqrstuvwxyz/);

  let inspectText = "";
  await commands.get("subagents").handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        component.handleInput("\r");
        inspectText = component.render(120).join("\n");
        return Promise.resolve(undefined);
      },
    },
  });

  assert.match(inspectText, /Error: abcde…/);
  assert.match(inspectText, /Message: 0123…/);
  assert.doesNotMatch(inspectText, /abcdefghijklmnopqrstuvwxyz/);
});

test("/subagents command reports custom UI failure without throwing", async () => {
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [fakeAgent({ config: { name: "helper", resumable: true, source: "project" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "done" }, turns: 1 })],
  };
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const notifications: any[] = [];
  await assert.doesNotReject(() => commands.get("subagents").handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify: (...args: any[]) => notifications.push(args),
      custom() { throw new Error("custom unavailable"); },
    },
  }));

  assert.match(notifications.at(-1)[0], /Subagents UI failed: custom unavailable/);
  assert.equal(notifications.at(-1)[1], "warning");
});

test("subagents command opens a sessions view from serialized DTOs", async () => {
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [fakeAgent({ config: { resumable: true }, options: { prompt: "Fix issue by updating the API" } })],
  };
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  const command = commands.get("subagents");
  assert.ok(command);

  let rendered: string[] = [];
  await command.handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        rendered = component.render(100);
        return Promise.resolve(null);
      },
    },
  });

  const text = rendered.join("\n");
  assert.match(text, /Subagent Sessions/);
  assert.match(text, /helper/);
  assert.match(text, /completed/);
  assert.match(text, /resumable/);
  assert.match(text, /session:s1/);
  assert.doesNotMatch(text, /"config"/);
});

test("/subagents resume reports an editor failure (missing or throwing) without invoking the runner", async () => {
  const cases: Array<{ label: string; editor?: () => never; matchNotification: RegExp }> = [
    { label: "missing", matchNotification: /Resume UI is unavailable/ },
    { label: "throws", editor: () => { throw new Error("editor unavailable"); }, matchNotification: /editor unavailable/ },
  ];

  for (const { label, editor, matchNotification } of cases) {
    let runCalls = 0;
    const fakeManager = {
      listSessions(): any[] { return this.sessions; },
      sessions: [fakeAgent({ config: { resumable: true } })],
      startRun() { runCalls += 1; throw new Error("run should not start"); },
    };
    const commands = registerCommand({
      agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
      agentManager: fakeManager,
    });

    const notifications: any[] = [];
    await assert.doesNotReject(() => commands.get("subagents").handler("", {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        notify: (...args: any[]) => notifications.push(args),
        ...(editor ? { editor } : {}),
        custom(factory: any) {
          const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
          component.handleInput("r");
          return Promise.resolve({ action: "resume", sessionId: "s1", agent: "helper" });
        },
      },
    }), `${label}: handler rejected`);

    assert.equal(runCalls, 0, `${label}: runner was invoked`);
    assert.match(notifications.at(-1)[0], matchNotification, `${label}: notification did not match`);
  }
});

test("subagents command resumes completed retained session with editor loader and visible concise message", async () => {
  const resumeCalls: any[] = [];
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [fakeAgent({ config: { resumable: true } })],
    startRun(_ctx: any, signal: AbortSignal, tasks: any[]) {
      const task = tasks[0];
      resumeCalls.push({ signal, sessionId: task.sessionId, prompt: task.prompt });
      const resultsPromise = Promise.resolve([fakeAgent({
        id: task.sessionId,
        config: { name: "helper", resumable: true },
        prompt: task.prompt,
        status: { kind: "completed", response: `Result ${"z".repeat(1000)}`, resumed: true },
      })]);
      return { groupId: "g", sessions: [], tree: () => [], resultsPromise };
    },
  };
  const sentMessages: any[] = [];
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
    __sentMessages: sentMessages,
  });

  let customCalls = 0;
  const editorCalls: any[] = [];
  await commands.get("subagents").handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget() {},
      editor(title: string, prefill: string) {
        editorCalls.push({ title, prefill });
        return Promise.resolve("follow\nup");
      },
      custom(factory: any) {
        customCalls += 1;
        return new Promise<any>(resolve => {
          let resolved = false;
          let component: any;
          const done = (value: any) => {
            resolved = true;
            component?.dispose?.();
            resolve(value);
          };
          component = factory({ requestRender() {} }, passthroughTheme, {}, done);
          if (customCalls === 1) {
            component.handleInput("r");
            setImmediate(() => { if (!resolved) resolve(undefined); });
          }
        });
      },
    },
  });

  assert.equal(customCalls, 2);
  assert.equal(editorCalls[0].title, "Resume subagent helper");
  assert.deepEqual(resumeCalls.map(call => [call.sessionId, call.prompt]), [["s1", "follow\nup"]]);
  assert.ok(resumeCalls[0].signal instanceof AbortSignal);
  assert.equal(sentMessages.length, 1);
  assert.notEqual(sentMessages[0].options?.deliverAs, "nextTurn");
  assert.equal(sentMessages[0].message.customType, "subagent-resume");
  assert.equal(sentMessages[0].message.display, true);
  assert.match(sentMessages[0].message.content, /Subagent resume completed/);
  assert.equal(sentMessages[0].message.content.includes("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), false);
  assert.equal(sentMessages[0].message.details.result.output.startsWith("Result z"), true);
});

test("subagents command resume cancellation aborts the child and reports interruption", async () => {
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [fakeAgent({ config: { resumable: true } })],
    startRun(_ctx: any, signal: AbortSignal, tasks: any[]) {
      const task = tasks[0];
      const resultsPromise = new Promise<any[]>(resolve => {
        signal.addEventListener("abort", () => {
          resolve([fakeAgent({
            id: task.sessionId,
            config: { name: "helper", resumable: true },
            prompt: task.prompt,
            status: { kind: "interrupted", error: "Agent interrupted.", resumed: true },
          })]);
        }, { once: true });
      });
      return { groupId: "g", sessions: [], tree: () => [], resultsPromise };
    },
  };
  const sentMessages: any[] = [];
  const commands = new Map<string, any>();
  subagentExtension({
    registerTool() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer() {},
    sendMessage: (message: any) => sentMessages.push(message),
  } as any, {
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } } as any,
    agentManager: fakeManager as any,
  });

  let customCalls = 0;
  const notifications: any[] = [];
  await commands.get("subagents").handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify: (...args: any[]) => notifications.push(args),
      setWidget() {},
      editor() { return Promise.resolve("follow up"); },
      custom(factory: any) {
        customCalls += 1;
        return new Promise<any>(resolve => {
          const component = factory({ requestRender() {} }, passthroughTheme, {}, resolve);
          if (customCalls === 1) component.handleInput("r");
          if (customCalls === 2) component.handleInput("\x1b[27u");
        });
      },
    },
  });

  assert.equal(customCalls, 2);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].content, /Subagent resume interrupted/);
  assert.match(sentMessages[0].content, /error: Agent interrupted/);
  assert.equal(sentMessages[0].details.status, "interrupted");
  assert.match(notifications.at(-1)[0], /resume interrupted/);
});

test("subagents command inspect view shows metadata and removes retained session immediately", async () => {
  const retainedSession = fakeAgent({
    config: { resumable: true, tools: ["read", "bash"] },
    options: { prompt: "Fix retained context", model: "test/model", thinking: "low" },
    status: { kind: "completed", startedAt: 2_000, completedAt: 5_000, response: "Implemented the retained-session fix." },
    turns: 3, toolUses: 2, compactions: 1, createdAt: 1_000,
    totalUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  });
  const clearCalls: string[] = [];
  const fakeManager = {
    listSessions(): any[] { return this.sessions; },
    sessions: [retainedSession],
    async remove(args: any) {
      const [sessionId] = args.sessionIds;
      clearCalls.push(sessionId);
      this.sessions = this.sessions.filter((s: any) => s.id !== sessionId);
      return { removed: 1, aborted: 0, sessionIds: [sessionId], errors: [] };
    },
  };
  const commands = registerCommand({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: fakeManager,
  });

  let inspectText = "";
  const notifications: any[] = [];
  await commands.get("subagents").handler("", {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify: (...args: any[]) => notifications.push(args),
      custom(factory: any) {
        const component = factory({ requestRender() {} }, passthroughTheme, {}, () => {});
        component.handleInput("\r");
        inspectText = component.render(120).join("\n");
        component.handleInput("c");
        return Promise.resolve(null);
      },
    },
  });

  assert.match(inspectText, /Status: completed · resumable/);
  assert.match(inspectText, /Agent: helper \(project\)/);
  assert.match(inspectText, /Model: test\/model · thinking:low/);
  assert.match(inspectText, /Tools: read, bash/);
  assert.match(inspectText, /Progress: 3 turns · 2 tool uses · 1 compaction/);
  assert.match(inspectText, /Usage: 3 tokens · \$0\.0100/);
  assert.match(inspectText, /Output: Implemented the retained-session fix/);
  assert.match(inspectText, /Actions: inspect, resume, remove/);
  assert.doesNotMatch(inspectText, /clear/);
  assert.deepEqual(clearCalls, ["s1"]);
  assert.deepEqual(fakeManager.sessions, []);
  assert.match(notifications.at(-1)[0], /Removed subagent session s1/);
});
