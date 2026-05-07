import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const unique = () => `${Date.now()}-${Math.random()}`;

test('subagent UI settings default to below editor when file is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-settings-default-'));
  const { SubagentUiSettingsStore } = await import(`../dist/subagent-settings.js?t=${unique()}`);
  const store = new SubagentUiSettingsStore(join(root, 'subagent', 'settings.json'));

  const result = await store.load();

  assert.deepEqual(result.settings, { widgetPlacement: 'belowEditor' });
  assert.equal(result.warning, undefined);
});

test('subagent UI settings save and reload widget placement globally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-settings-save-'));
  const settingsPath = join(root, 'subagent', 'settings.json');
  const { SubagentUiSettingsStore } = await import(`../dist/subagent-settings.js?t=${unique()}`);

  await new SubagentUiSettingsStore(settingsPath).save({ widgetPlacement: 'aboveEditor' });
  const result = await new SubagentUiSettingsStore(settingsPath).load();

  assert.deepEqual(result.settings, { widgetPlacement: 'aboveEditor' });
  assert.equal(result.warning, undefined);
});

test('subagent UI settings fall back to defaults for invalid config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-settings-invalid-'));
  const settingsPath = join(root, 'subagent', 'settings.json');
  await mkdir(join(root, 'subagent'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ widgetPlacement: 'besideEditor' }));
  const { SubagentUiSettingsStore } = await import(`../dist/subagent-settings.js?t=${unique()}`);

  const result = await new SubagentUiSettingsStore(settingsPath).load();

  assert.deepEqual(result.settings, { widgetPlacement: 'belowEditor' });
  assert.match(result.warning, /widgetPlacement/);
});

test('registry loads markdown files from ctx cwd project dir and keys by frontmatter name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-registry-'));
  const projectAgents = join(root, '.pi', 'agents');
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, 'filename.md'), `---\nname: runtime-name\ndescription: Runtime description\nresumable: true\n---\nSystem prompt`);

  const { AgentRegistry } = await import(`../dist/agent-registry.js?t=${unique()}`);
  const registry = new AgentRegistry();
  await registry.reload(root);

  assert.equal(registry.agents.has('filename'), false);
  assert.equal(registry.agents.get('runtime-name')?.systemPrompt, 'System prompt');
  assert.equal(registry.agents.get('runtime-name')?.resumable, true);
});

test('agent transitions from queued to terminal states and rejects invalid transitions', async () => {
  const { Agent } = await import(`../dist/agent.js?t=${unique()}`);
  const config = { name: 'agent', description: 'desc', systemPrompt: 'prompt', source: 'project' };
  const opts = { agent: 'agent', prompt: 'do work' };
  const session = { abort() {} };

  const running = new Agent('id', 'group', config, opts, () => {});
  assert.doesNotThrow(() => running.start(session));
  assert.equal(running.status.kind, 'running');
  assert.throws(() => running.start(session), /Cannot start/);
  assert.doesNotThrow(() => running.complete('done'));
  assert.equal(running.status.kind, 'completed');
  assert.throws(() => running.error('late'), /Cannot error/);

  for (const action of ['abort', 'error']) {
    const agent = new Agent(action, 'group', config, opts, () => {});
    assert.throws(() => agent[action]('boom'), /has not started|is not running/);
    agent.start(session);
    assert.doesNotThrow(() => agent[action]('boom'));
  }
});

test('subagent extension still registers the tool when custom resume renderer registration fails', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;

  assert.doesNotThrow(() => subagentExtension({
    registerCommand() {},
    registerMessageRenderer() { throw new Error('renderer unsupported'); },
    registerTool: tool => { registeredTool = tool; },
  }));

  assert.equal(registeredTool.name, 'subagent');
});

test('tool execution requires action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-action-'));
  let registeredTool;
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  const result = await registeredTool.execute('tool-call', {
    tasks: [],
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Provide an action/);
});

test('tool execution validates task count and reports available agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-validation-'));
  const projectAgents = join(root, '.pi', 'agents');
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, 'helper.md'), `---\nname: helper\ndescription: Helps\n---\nHelp prompt`);

  let registeredTool;
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  const result = await registeredTool.execute('tool-call', {
    action: 'start',
    tasks: Array.from({ length: 9 }, (_, i) => ({ agent: 'helper', prompt: `task ${i}` })),
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Too many tasks \(9\)\. Max is 8/);
  assert.match(result.content[0].text, /helper \(project\)/);
});

test('tool list action returns agent definitions or resumable sessions by type', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-list-'));
  const projectAgents = join(root, '.pi', 'agents');
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, 'helper.md'), `---\nname: helper\ndescription: Helps\nresumable: true\nmodel: test/model\ntools: read, bash\n---\nHelp prompt`);

  let registeredTool;
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  const agents = await registeredTool.execute('tool-call', {
    action: 'list',
  }, undefined, undefined, { cwd: root });
  assert.equal(agents.isError, false);
  const helper = agents.details.agents.find(agent => agent.name === 'helper');
  assert.ok(helper);
  assert.equal(helper.resumable, true);
  assert.deepEqual(helper.tools, ['read', 'bash']);
  assert.equal(helper.sourcePath, join(projectAgents, 'helper.md'));
  assert.equal(Object.prototype.hasOwnProperty.call(helper, 'systemPrompt'), false);

  const sessions = await registeredTool.execute('tool-call', {
    action: 'list',
    type: 'sessions',
  }, undefined, undefined, { cwd: root });
  assert.equal(sessions.isError, false);
  assert.deepEqual(sessions.details.sessions, []);
});

test('tool resume action returns full output only once in JSON details', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const fullOutput = `resume output ${'q'.repeat(1500)} tail`;
  let registeredTool;
  const fakeManager = {
    sessions: [],
    resume(_ctx, _signal, sessionId, prompt) {
      return Promise.resolve({ agent: 'helper', prompt, status: 'completed', output: fullOutput, sessionId, resumable: true });
    },
  };

  subagentExtension({
    registerCommand() {},
    registerMessageRenderer() {},
    registerTool: tool => { registeredTool = tool; },
  }, {
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } },
    agentManager: fakeManager,
  });

  const result = await registeredTool.execute('tool-call', {
    action: 'resume',
    sessionId: 's1',
    prompt: 'follow up',
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, false);
  assert.equal(result.details.result.output, fullOutput);
  assert.equal((result.content[0].text.match(new RegExp(fullOutput, 'g')) ?? []).length, 1);
  assert.equal(result.details.message?.details?.result?.output, undefined);
});

test('/subagents settings exposes placement values, saves changes, and updates active widget', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const runningSession = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'running', resumable: false,
    promptPreview: 'Fix issue', turns: 1, toolUses: 0, createdAt: 1, startedAt: 1,
  };
  const fakeManager = {
    sessions: [runningSession],
    listSessions() { return this.sessions; },
  };
  let current = 'belowEditor';
  const saved = [];
  const fakeSettingsStore = {
    async load() { return { settings: { widgetPlacement: current } }; },
    async save(settings) { current = settings.widgetPlacement; saved.push(settings); },
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } }, agentManager: fakeManager, settingsStore: fakeSettingsStore });

  let rendered = '';
  const widgets = [];
  const theme = { fg: (_color, text) => text, bold: text => text };
  await commands.get('subagents').handler('settings', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget: (...args) => widgets.push(args),
      custom(factory) {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        rendered = component.render(120).join('\n');
        component.handleInput('\r');
        return Promise.resolve(undefined);
      },
    },
  });

  assert.match(rendered, /Subagent Settings/);
  assert.match(rendered, /Widget placement/);
  assert.match(rendered, /belowEditor/);
  assert.match(rendered, /Values: belowEditor, aboveEditor, off/);
  assert.deepEqual(saved, [{ widgetPlacement: 'aboveEditor' }]);
  assert.equal(widgets.at(-1)[0], 'subagent');
  assert.deepEqual(widgets.at(-1)[2], { placement: 'aboveEditor' });
});

test('/subagents settings persists the latest rapid placement change before command completion', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const runningSession = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'running', resumable: false,
    promptPreview: 'Fix issue', turns: 1, toolUses: 0, createdAt: 1, startedAt: 1,
  };
  const fakeManager = {
    sessions: [runningSession],
    listSessions() { return this.sessions; },
  };
  let persisted = 'belowEditor';
  let releaseFirstSave;
  const fakeSettingsStore = {
    async load() { return { settings: { widgetPlacement: persisted } }; },
    save(settings) {
      if (settings.widgetPlacement === 'aboveEditor') {
        return new Promise(resolve => {
          releaseFirstSave = () => {
            persisted = settings.widgetPlacement;
            resolve();
          };
        });
      }
      persisted = settings.widgetPlacement;
      return Promise.resolve();
    },
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } }, agentManager: fakeManager, settingsStore: fakeSettingsStore });

  const widgets = [];
  const theme = { fg: (_color, text) => text, bold: text => text };
  const handlerPromise = commands.get('subagents').handler('settings', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget: (...args) => widgets.push(args),
      custom(factory) {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        component.handleInput('\r');
        component.handleInput('\r');
        return Promise.resolve(undefined);
      },
    },
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(widgets.at(-1)[0], 'subagent');
  assert.equal(widgets.at(-1)[1], undefined);

  assert.equal(typeof releaseFirstSave, 'function');
  releaseFirstSave();
  await handlerPromise;

  assert.equal(persisted, 'off');
});

test('/subagents command no-ops without UI or notify instead of throwing', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project', resumable: false }]]),
    async reload() {},
    summarizeAgent() { return ''; },
  };
  const fakeManager = {
    sessions: [],
    listSessions() { return this.sessions; },
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: fakeRegistry, agentManager: fakeManager });

  await assert.doesNotReject(() => commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: false,
  }));
});

test('/subagents command does not notify through UI when hasUI is false', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project', resumable: false }]]),
    async reload() {},
    summarizeAgent() { return ''; },
  };
  const fakeManager = {
    sessions: [],
    listSessions() { return this.sessions; },
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: fakeRegistry, agentManager: fakeManager });

  let notifyCalls = 0;
  await commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: false,
    ui: { notify() { notifyCalls += 1; } },
  });

  assert.equal(notifyCalls, 0);
});

test('subagents command opens agents browser by default when sessions are empty', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const reloadCalls = [];
  const fakeRegistry = {
    agents: new Map([
      ['helper', { name: 'helper', description: 'Helps with implementation', source: 'project', resumable: true, model: 'test/model', thinking: 'high', tools: ['read', 'bash'], sourcePath: '/repo/.pi/agents/helper.md' }],
      ['reviewer', { name: 'reviewer', description: 'Reviews changes', source: 'user', resumable: false }],
    ]),
    async reload(cwd) { reloadCalls.push(cwd); },
    summarizeAgent() { return ''; },
  };
  const fakeManager = {
    sessions: [],
    listSessions() { return this.sessions; },
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: fakeRegistry, agentManager: fakeManager });

  let listText = '';
  let inspectText = '';
  const theme = { fg: (_color, text) => text, bold: text => text };
  await commands.get('subagents').handler('', {
    cwd: '/repo',
    hasUI: true,
    ui: {
      notify() {},
      custom(factory) {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        listText = component.render(120).join('\n');
        component.handleInput('\r');
        inspectText = component.render(120).join('\n');
        return Promise.resolve(undefined);
      },
    },
  });

  assert.deepEqual(reloadCalls, ['/repo']);
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

test('/subagents command reports custom UI failure without throwing', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const fakeRegistry = {
    agents: new Map(),
    async reload() {},
    summarizeAgent() { return ''; },
  };
  const fakeManager = {
    sessions: [{
      id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'completed', resumable: true,
      promptPreview: 'Fix issue', turns: 1, toolUses: 0, compactions: 0,
      createdAt: 1, startedAt: 1, completedAt: 2,
      availableActions: ['inspect', 'clear'], finalOutcome: { status: 'completed' },
    }],
    listSessions() { return this.sessions; },
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: fakeRegistry, agentManager: fakeManager });

  const notifications = [];
  await assert.doesNotReject(() => commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify: (...args) => notifications.push(args),
      custom() { throw new Error('custom unavailable'); },
    },
  }));

  assert.match(notifications.at(-1)[0], /Subagents UI failed: custom unavailable/);
  assert.equal(notifications.at(-1)[1], 'warning');
});

test('subagents command opens a sessions view from serialized DTOs', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const fakeRegistry = {
    agents: new Map(),
    async reload() {},
    summarizeAgent() { return ''; },
  };
  const fakeManager = {
    sessions: [
      {
        id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'completed', resumable: true,
        promptPreview: 'Fix issue by updating the API', turns: 3, toolUses: 2, compactions: 1,
        createdAt: 1_000, startedAt: 2_000, completedAt: 5_000, source: 'project', model: 'test/model', thinking: 'low',
        tools: ['read', 'bash'], outputSnippet: 'Implemented the fix.', availableActions: ['inspect', 'clear'],
        finalOutcome: { status: 'completed' },
      },
    ],
    listSessions() { return this.sessions; },
  };
  const commands = new Map();

  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: fakeRegistry, agentManager: fakeManager });

  const command = commands.get('subagents');
  assert.ok(command);

  let rendered = [];
  const theme = { fg: (_color, text) => text, bold: text => text };
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory) {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        rendered = component.render(100);
        return Promise.resolve(null);
      },
    },
  };

  await command.handler('', ctx);

  const text = rendered.join('\n');
  assert.match(text, /Subagent Sessions/);
  assert.match(text, /helper/);
  assert.match(text, /completed/);
  assert.match(text, /resumable/);
  assert.match(text, /session:s1/);
  assert.match(text, /Fix issue by updating the API/);
  assert.doesNotMatch(text, /"config"/);
});

test('/subagents command handles resume when editor UI is unavailable', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const retainedSession = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'completed', resumable: true,
    promptPreview: 'Initial prompt', turns: 1, toolUses: 0, compactions: 0,
    createdAt: 1_000, startedAt: 2_000, completedAt: 3_000,
    outputSnippet: 'Initial output', availableActions: ['inspect', 'resume', 'clear'],
    finalOutcome: { status: 'completed' },
  };
  const fakeManager = {
    sessions: [retainedSession],
    listSessions() { return this.sessions; },
    resume() { throw new Error('resume should not start'); },
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } }, agentManager: fakeManager });

  const notifications = [];
  await assert.doesNotReject(() => commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify: (...args) => notifications.push(args),
      custom(factory) {
        const theme = { fg: (_color, text) => text, bold: text => text };
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        component.handleInput('r');
        return Promise.resolve({ action: 'resume', sessionId: 's1', agent: 'helper' });
      },
    },
  }));

  assert.match(notifications.at(-1)[0], /Resume UI is unavailable/);
});

test('subagents command resumes completed retained session with editor loader and visible concise message', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const retainedSession = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'completed', resumable: true,
    promptPreview: 'Initial prompt', turns: 1, toolUses: 0, compactions: 0,
    createdAt: 1_000, startedAt: 2_000, completedAt: 3_000,
    outputSnippet: 'Initial output', availableActions: ['inspect', 'resume', 'clear'],
    finalOutcome: { status: 'completed' },
  };
  const resumeCalls = [];
  const fakeManager = {
    sessions: [retainedSession],
    listSessions() { return this.sessions; },
    resume(_ctx, signal, sessionId, prompt) {
      resumeCalls.push({ signal, sessionId, prompt });
      return Promise.resolve({ agent: 'helper', prompt, status: 'completed', output: `Result ${'z'.repeat(1000)}`, sessionId, resumable: true });
    },
  };
  const commands = new Map();
  const sentMessages = [];
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer() {},
    sendMessage: (message, options) => sentMessages.push({ message, options }),
  }, { agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } }, agentManager: fakeManager });

  let customCalls = 0;
  const editorCalls = [];
  const theme = { fg: (_color, text) => text, bold: text => text };
  await commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget() {},
      editor(title, prefill) {
        editorCalls.push({ title, prefill });
        return Promise.resolve('follow\nup');
      },
      custom(factory) {
        customCalls += 1;
        return new Promise(resolve => {
          let resolved = false;
          let component;
          const done = value => {
            resolved = true;
            component?.dispose?.();
            resolve(value);
          };
          component = factory({ requestRender() {} }, theme, {}, done);
          if (customCalls === 1) {
            component.handleInput('r');
            setImmediate(() => { if (!resolved) resolve(undefined); });
          }
        });
      },
    },
  });

  assert.equal(customCalls, 2);
  assert.equal(editorCalls[0].title, 'Resume subagent helper');
  assert.deepEqual(resumeCalls.map(call => [call.sessionId, call.prompt]), [['s1', 'follow\nup']]);
  assert.ok(resumeCalls[0].signal instanceof AbortSignal);
  assert.equal(sentMessages.length, 1);
  assert.notEqual(sentMessages[0].options?.deliverAs, 'nextTurn');
  assert.equal(sentMessages[0].message.customType, 'subagent-resume');
  assert.equal(sentMessages[0].message.display, true);
  assert.match(sentMessages[0].message.content, /Subagent resume completed/);
  assert.equal(sentMessages[0].message.content.includes('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), false);
  assert.equal(sentMessages[0].message.details.result.output.startsWith('Result z'), true);
});

test('subagents command resume cancellation aborts the child and reports interruption', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const retainedSession = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'completed', resumable: true,
    promptPreview: 'Initial prompt', turns: 1, toolUses: 0, compactions: 0,
    createdAt: 1_000, startedAt: 2_000, completedAt: 3_000,
    outputSnippet: 'Initial output', availableActions: ['inspect', 'resume', 'clear'],
    finalOutcome: { status: 'completed' },
  };
  const fakeManager = {
    sessions: [retainedSession],
    listSessions() { return this.sessions; },
    resume(_ctx, signal, sessionId, prompt) {
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          this.sessions = [{ ...retainedSession, status: 'interrupted', availableActions: ['inspect', 'clear'], errorSnippet: 'Agent interrupted.' }];
          resolve({ agent: 'helper', prompt, status: 'interrupted', error: 'Agent interrupted.', sessionId, resumable: true });
        }, { once: true });
      });
    },
  };
  const commands = new Map();
  const sentMessages = [];
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer() {},
    sendMessage: message => sentMessages.push(message),
  }, { agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } }, agentManager: fakeManager });

  let customCalls = 0;
  const notifications = [];
  const theme = { fg: (_color, text) => text, bold: text => text };
  await commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify: (...args) => notifications.push(args),
      setWidget() {},
      editor() { return Promise.resolve('follow up'); },
      custom(factory) {
        customCalls += 1;
        return new Promise(resolve => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          if (customCalls === 1) component.handleInput('r');
          if (customCalls === 2) component.handleInput('\x1b');
        });
      },
    },
  });

  assert.equal(customCalls, 2);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].content, /Subagent resume interrupted/);
  assert.match(sentMessages[0].content, /error: Agent interrupted/);
  assert.equal(sentMessages[0].details.status, 'interrupted');
  assert.match(notifications.at(-1)[0], /resume interrupted/);
});

test('subagents command inspect view shows metadata and clears retained session immediately', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const retainedSession = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'completed', resumable: true,
    promptPreview: 'Fix retained context', turns: 3, toolUses: 2, compactions: 1,
    createdAt: 1_000, startedAt: 2_000, completedAt: 5_000, source: 'project', model: 'test/model', thinking: 'low',
    tools: ['read', 'bash'], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
    outputSnippet: 'Implemented the retained-session fix.', availableActions: ['inspect', 'clear'],
    finalOutcome: { status: 'completed' },
  };
  const clearCalls = [];
  const fakeManager = {
    sessions: [retainedSession],
    listSessions() { return this.sessions; },
    clear(sessionId) {
      clearCalls.push(sessionId);
      this.sessions = this.sessions.filter(session => session.sessionId !== sessionId);
      return { cleared: 1, sessionId };
    },
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } }, agentManager: fakeManager });

  let inspectText = '';
  const notifications = [];
  const theme = { fg: (_color, text) => text, bold: text => text };
  await commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify: (...args) => notifications.push(args),
      custom(factory) {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        component.handleInput('\r');
        inspectText = component.render(120).join('\n');
        component.handleInput('c');
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
  assert.match(inspectText, /Actions: inspect, clear/);
  assert.deepEqual(clearCalls, ['s1']);
  assert.deepEqual(fakeManager.sessions, []);
  assert.match(notifications.at(-1)[0], /Cleared subagent session s1/);
});

test('subagent tool lists retained sessions as serialized DTOs with clear action', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent) => {
    agent.start(session);
    agent.complete('The final answer from the child.');
    return { response: 'The final answer from the child.', session };
  };
  const fakeRegistry = {
    agents: new Map([
      ['chatty', { name: 'chatty', description: 'Keeps context', systemPrompt: 's', source: 'project', resumable: true, model: 'test/model', tools: ['read'] }],
    ]),
    async reload() {},
    summarizeAgent() { return 'chatty (project)'; },
  };
  const manager = new AgentManager(fakeRegistry, 1, runner);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, { agentRegistry: fakeRegistry, agentManager: manager });

  await registeredTool.execute('tool-call', {
    action: 'start',
    tasks: [{ agent: 'chatty', prompt: 'Remember this work.' }],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false, modelRegistry: { getAll: () => [] } });

  const result = await registeredTool.execute('tool-call', {
    action: 'list',
    type: 'sessions',
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, false);
  assert.equal(result.details.sessions.length, 1);
  const retained = result.details.sessions[0];
  assert.equal(retained.agent, 'chatty');
  assert.equal(retained.status, 'completed');
  assert.equal(retained.source, 'project');
  assert.equal(retained.model, 'test/model');
  assert.deepEqual(retained.tools, ['read']);
  assert.equal(retained.outputSnippet, 'The final answer from the child.');
  assert.deepEqual(retained.availableActions, ['inspect', 'resume', 'clear']);
  assert.equal(Object.prototype.hasOwnProperty.call(retained, 'config'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(retained, 'run'), false);
});

test('subagent tool call renderer falls back to simple text when themed rendering fails', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  let component;
  assert.doesNotThrow(() => {
    component = registeredTool.renderCall({ action: 'start', tasks: [{ agent: 'helper', prompt: 'work' }] }, { fg() { throw new Error('theme failed'); } });
  });
  assert.match(component.render(80).join('\n'), /subagent start · 1 task/);
});

test('subagent tool result renderer falls back to simple text when themed rendering fails', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  let component;
  assert.doesNotThrow(() => {
    component = registeredTool.renderResult({
      content: [{ type: 'text', text: 'plain fallback helper output' }],
      details: {
        sessions: [{
          id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'completed', resumable: false,
          promptPreview: 'work', turns: 1, toolUses: 0, compactions: 0, createdAt: 1, completedAt: 2,
          availableActions: ['inspect'], finalOutcome: { status: 'completed' },
        }],
      },
    }, { expanded: true }, { fg() { throw new Error('theme failed'); } });
  });

  assert.match(component.render(120).join('\n'), /plain fallback helper output/);
});

test('tool execution returns structured failed run for unknown agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-unknown-'));
  let registeredTool;
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  const result = await registeredTool.execute('tool-call', {
    action: 'start',
    tasks: [{ agent: 'missing', prompt: 'do work' }],
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details.results.map(r => r.agent), ['missing']);
  assert.equal(result.details.results[0].status, 'error');
  assert.match(result.content[0].text, /"results"/);
});

test('manager returns ordered per-run output and reports unknown agents and child failures', async () => {
  const calls = [];
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const runner = async (_ctx, agent) => {
    calls.push(agent.options.prompt);
    if (agent.options.prompt === 'three') throw new Error('child failed');
    return { response: `response:${agent.options.prompt}`, session: {} };
  };

  const registry = { agents: new Map([
    ['good', { name: 'good', description: 'd', systemPrompt: 's', source: 'project' }],
    ['bad', { name: 'bad', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const manager = new AgentManager(registry, 2, runner);
  const results = await manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { agent: 'good', prompt: 'one', model: 'm1' },
    { agent: 'missing', prompt: 'two' },
    { agent: 'bad', prompt: 'three' },
  ]);

  assert.deepEqual(calls.sort(), ['one', 'three']);
  assert.deepEqual(results.map(r => r.agent), ['good', 'missing', 'bad']);
  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].output, 'response:one');
  assert.equal(results[0].model, 'm1');
  assert.equal(results[1].status, 'error');
  assert.match(results[1].error, /Unknown agent/);
  assert.equal(results[2].status, 'error');
  assert.match(results[2].error, /child failed/);
});

test('manager marks runner rejections before start as terminal error in grouped progress', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const runner = async () => {
    throw new Error('setup failed before start');
  };
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const manager = new AgentManager(registry, 1, runner);
  const updates = [];

  const results = await manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { agent: 'helper', prompt: 'work' },
  ], update => updates.push(update));

  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /setup failed before start/);
  const final = updates.at(-1);
  assert.equal(final.active, false);
  assert.equal(final.group.isError, true);
  assert.deepEqual(final.group.statusCounts, { error: 1 });
  assert.equal(final.sessions[0].status, 'error');
  assert.equal(final.sessions[0].finalOutcome.status, 'error');
  assert.match(final.sessions[0].finalOutcome.message, /setup failed before start/);
  assert.deepEqual(manager.listSessions(), []);
});

test('manager returns skipped result and final group row for queued task whose signal aborted before it can start', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const calls = [];
  let finishFirst;
  const firstCanFinish = new Promise(resolve => { finishFirst = resolve; });
  const runner = async (_ctx, agent) => {
    calls.push(agent.options.prompt);
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    agent.start(session);
    if (agent.options.prompt === 'one') await firstCanFinish;
    agent.complete(`done:${agent.options.prompt}`);
    return { response: `done:${agent.options.prompt}`, session };
  };
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const manager = new AgentManager(registry, 1, runner);
  const controller = new AbortController();
  const updates = [];

  const pending = manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, controller.signal, [
    { agent: 'helper', prompt: 'one' },
    { agent: 'helper', prompt: 'two' },
  ], update => updates.push(update));

  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  finishFirst();
  const results = await pending;

  assert.deepEqual(calls, ['one']);
  assert.equal(results[0].status, 'completed');
  assert.equal(results[1].status, 'skipped');
  assert.equal(results[1].resumable, false);
  const final = updates.at(-1).group;
  assert.deepEqual(final.statusCounts, { completed: 1, skipped: 1 });
  assert.equal(final.isError, true);
  assert.deepEqual(final.sessions.map(session => session.status), ['completed', 'skipped']);
  assert.equal(final.sessions[1].finalOutcome.status, 'skipped');
  assert.deepEqual(manager.listSessions(), []);
});

test('manager does not expose skipped resumable tasks as sessions', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  let finishFirst;
  const firstCanFinish = new Promise(resolve => { finishFirst = resolve; });
  const runner = async (_ctx, agent) => {
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    agent.start(session);
    await firstCanFinish;
    agent.complete('done');
    return { response: 'done', session };
  };
  const registry = { agents: new Map([
    ['blocker', { name: 'blocker', description: 'd', systemPrompt: 's', source: 'project', resumable: false }],
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 1, runner);
  const controller = new AbortController();

  const pending = manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, controller.signal, [
    { agent: 'blocker', prompt: 'one' },
    { agent: 'chatty', prompt: 'two' },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  finishFirst();
  const results = await pending;

  assert.equal(results[1].status, 'skipped');
  assert.equal(results[1].resumable, false);
  assert.equal(Object.prototype.hasOwnProperty.call(results[1], 'sessionId'), false);
  assert.deepEqual(manager.listSessions(), []);
  assert.deepEqual(manager.clear(), { cleared: 0 });
});

test('manager does not expose or resume non-resumable completed sessions', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const runner = async (_ctx, agent) => {
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    agent.start(session);
    agent.complete('done');
    return { response: 'done', session };
  };
  const registry = { agents: new Map([
    ['oneshot', { name: 'oneshot', description: 'd', systemPrompt: 's', source: 'project', resumable: false }],
  ]) };
  const manager = new AgentManager(registry, 1, runner);

  const results = await manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { agent: 'oneshot', prompt: 'work' },
  ]);

  assert.equal(results[0].status, 'completed');
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], 'sessionId'), false);
  assert.deepEqual(manager.listSessions(), []);
  await assert.rejects(
    manager.resume({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, 'anything', 'follow up'),
    /Unknown resumable subagent session/,
  );
});

test('manager retains only resumable interrupted sessions inspect-clear only after parent cancellation settles', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const runner = async (_ctx, agent, signal) => {
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    agent.start(session);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    agent.interrupt('cancelled by parent');
    throw new Error('cancelled by parent');
  };
  const registry = { agents: new Map([
    ['oneshot', { name: 'oneshot', description: 'd', systemPrompt: 's', source: 'project', resumable: false }],
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 2, runner);
  const controller = new AbortController();

  const pending = manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, controller.signal, [
    { agent: 'oneshot', prompt: 'one' },
    { agent: 'chatty', prompt: 'two' },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  const results = await pending;

  assert.deepEqual(results.map(result => result.status), ['interrupted', 'interrupted']);
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], 'sessionId'), false);
  assert.ok(results[1].sessionId);

  const sessions = manager.listSessions();
  assert.deepEqual(sessions.map(session => session.agent), ['chatty']);
  assert.equal(sessions[0].status, 'interrupted');
  assert.equal(sessions[0].finalOutcome.status, 'interrupted');

  await assert.rejects(
    manager.resume({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, results[1].sessionId, 'follow up'),
    /while it is interrupted/,
  );
  assert.deepEqual(manager.clear(results[1].sessionId), { cleared: 1, sessionId: results[1].sessionId });
  assert.deepEqual(manager.listSessions(), []);
});

test('manager retains, resumes, lists, and clears completed resumable sessions', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const runner = async (_ctx, agent) => {
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    const response = `response:${agent.options.prompt}`;
    agent.start(session);
    agent.complete(response);
    return { response, session };
  };
  const resumeRunner = async (_ctx, agent, prompt) => {
    agent.resume(agent.status.session);
    const session = agent.status.session;
    const response = `follow:${prompt}`;
    agent.complete(response);
    return { response, session };
  };

  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 2, runner, resumeRunner);
  const results = await manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { agent: 'chatty', prompt: 'one' },
  ]);

  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].output, 'response:one');
  assert.ok(results[0].sessionId);

  assert.deepEqual(manager.listSessions().map(session => session.sessionId), [results[0].sessionId]);

  const resumed = await manager.resume({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, results[0].sessionId, 'two');
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.output, 'follow:two');
  assert.equal(resumed.prompt, 'two');
  assert.equal(resumed.sessionId, results[0].sessionId);

  assert.deepEqual(manager.clear(results[0].sessionId), { cleared: 1, sessionId: results[0].sessionId });
  assert.deepEqual(manager.listSessions(), []);
});

test('manager emits grouped progress DTO rows in input order including unknown agents', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent) => {
    agent.start(session);
    agent.complete(`done:${agent.options.prompt}`);
    return { response: `done:${agent.options.prompt}`, session };
  };
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const manager = new AgentManager(registry, 2, runner);
  const updates = [];

  const results = await manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { agent: 'helper', prompt: 'one' },
    { agent: 'missing', prompt: 'two' },
    { agent: 'helper', prompt: 'three' },
  ], update => updates.push(update));

  assert.deepEqual(results.map(result => result.agent), ['helper', 'missing', 'helper']);
  assert.deepEqual(results.map(result => result.status), ['completed', 'error', 'completed']);

  const initial = updates[0].group;
  assert.equal(initial.sessions.length, 3);
  assert.deepEqual(initial.sessions.map(session => session.agent), ['helper', 'missing', 'helper']);
  assert.deepEqual(initial.sessions.map(session => session.status), ['queued', 'error', 'queued']);
  assert.equal(initial.statusCounts.queued, 2);
  assert.equal(initial.statusCounts.error, 1);
  assert.equal(initial.isError, true);
  assert.match(initial.sessions[1].finalOutcome.message, /Unknown agent: missing/);
});

test('manager emits serialized one-child progress DTOs without exposing Agent instances', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project', model: 'test/model' }],
  ]) };
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent) => {
    agent.start(session);
    agent.messageUpdated('working through the delegated task');
    agent.toolStarted('read');
    agent.turnEnded();
    agent.toolEnded();
    agent.complete('done');
    return { response: 'done', session };
  };
  const manager = new AgentManager(registry, 1, runner);
  const updates = [];

  const results = await manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { agent: 'helper', prompt: 'Summarize the project status for the parent agent.' },
  ], update => updates.push(update));

  assert.equal(results[0].status, 'completed');
  assert.ok(updates.length >= 4);
  const queued = updates[0].sessions[0];
  assert.equal(queued.status, 'queued');
  assert.equal(queued.agent, 'helper');
  assert.equal(queued.model, 'test/model');
  assert.equal(queued.promptPreview, 'Summarize the project status for the parent agent.');
  assert.equal(Object.prototype.hasOwnProperty.call(queued, 'config'), false);

  assert.ok(updates.some(update => update.sessions[0].status === 'running'));
  assert.ok(updates.some(update => update.sessions[0].activeTool === 'read'));
  assert.ok(updates.some(update => update.sessions[0].turns === 1));
  assert.ok(updates.some(update => update.sessions[0].messageSnippet === 'working through the delegated task'));
  const final = updates.at(-1).sessions[0];
  assert.equal(final.status, 'completed');
  assert.equal(final.finalOutcome.status, 'completed');
});

test('subagent tool returns one ordered final group for mixed success, unknown, and failed children', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent) => {
    agent.start(session);
    if (agent.options.agent === 'flaky') throw new Error('flaky failed');
    agent.complete(`done:${agent.options.prompt}`);
    return { response: `done:${agent.options.prompt}`, session };
  };
  const fakeRegistry = {
    agents: new Map([
      ['helper', { name: 'helper', description: 'Helps', systemPrompt: 's', source: 'project' }],
      ['flaky', { name: 'flaky', description: 'Fails', systemPrompt: 's', source: 'project' }],
    ]),
    async reload() {},
    summarizeAgent() { return 'helper (project)\nflaky (project)'; },
  };
  const manager = new AgentManager(fakeRegistry, 2, runner);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, { agentRegistry: fakeRegistry, agentManager: manager });

  const result = await registeredTool.execute('tool-call', {
    action: 'start',
    tasks: [
      { agent: 'helper', prompt: 'first' },
      { agent: 'missing', prompt: 'second' },
      { agent: 'flaky', prompt: 'third' },
    ],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details.results.map(run => run.agent), ['helper', 'missing', 'flaky']);
  assert.equal(result.details.results[0].output, 'done:first');
  assert.deepEqual(result.details.results.map(run => run.status), ['completed', 'error', 'error']);
  assert.deepEqual(result.details.group.sessions.map(session => session.agent), ['helper', 'missing', 'flaky']);
  assert.deepEqual(result.details.group.sessions.map(session => session.status), ['completed', 'error', 'error']);
  assert.equal(result.details.group.statusCounts.completed, 1);
  assert.equal(result.details.group.statusCounts.error, 2);
  assert.equal(result.details.group.isError, true);
});

test('subagent tool notifies invalid settings fallback without breaking execution', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const runningSession = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'running', resumable: false,
    promptPreview: 'work', turns: 1, toolUses: 0, createdAt: 1, startedAt: 1,
  };
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  const fakeManager = {
    sessions: [],
    async spawn(_pi, _ctx, _signal, _options, onUpdate) {
      onUpdate({ groupId: 'g1', sessions: [runningSession], active: true, updatedAt: 1 });
      return [{ agent: 'helper', prompt: 'work', status: 'completed', output: 'done', sessionId: 's1', resumable: false }];
    },
  };
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, {
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: 'belowEditor' }, warning: 'Invalid subagent UI settings.' }; } },
  });

  const notifications = [];
  const widgets = [];
  const result = await registeredTool.execute('tool-call', {
    action: 'start',
    tasks: [{ agent: 'helper', prompt: 'work' }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args) => widgets.push(args), notify: (...args) => notifications.push(args) },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, 'done');
  assert.match(notifications[0][0], /Invalid subagent UI settings/);
  assert.equal(notifications[0][1], 'warning');
  assert.deepEqual(widgets[0][2], { placement: 'belowEditor' });
});

test('subagent tool falls back to default UI settings when settings load rejects', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const runningSession = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'running', resumable: false,
    promptPreview: 'work', turns: 1, toolUses: 0, createdAt: 1, startedAt: 1,
  };
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  const fakeManager = {
    sessions: [],
    async spawn(_pi, _ctx, _signal, _options, onUpdate) {
      onUpdate({ groupId: 'g1', sessions: [runningSession], active: true, updatedAt: 1 });
      return [{ agent: 'helper', prompt: 'work', status: 'completed', output: 'done', sessionId: 's1', resumable: false }];
    },
  };
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, {
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { throw new Error('disk unreadable'); } },
  });

  const notifications = [];
  const widgets = [];
  const result = await registeredTool.execute('tool-call', {
    action: 'start',
    tasks: [{ agent: 'helper', prompt: 'work' }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args) => widgets.push(args), notify: (...args) => notifications.push(args) },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, 'done');
  assert.match(notifications[0][0], /Failed to load subagent UI settings/);
  assert.equal(notifications[0][1], 'warning');
  assert.deepEqual(widgets[0][2], { placement: 'belowEditor' });
});

test('subagent tool keeps subagent surfaces working but hides widget when placement is off', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const runningSession = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'running', resumable: false,
    promptPreview: 'work', messageSnippet: 'working', turns: 1, toolUses: 0, createdAt: 1, startedAt: 1,
  };
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  const fakeManager = {
    sessions: [runningSession],
    async spawn(_pi, _ctx, _signal, _options, onUpdate) {
      onUpdate({ groupId: 'g1', sessions: [runningSession], active: true, updatedAt: 1 });
      return [{ agent: 'helper', prompt: 'work', status: 'completed', output: 'done', sessionId: 's1', resumable: false }];
    },
  };
  const fakeSettingsStore = {
    async load() { return { settings: { widgetPlacement: 'off' } }; },
  };
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, {
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: fakeSettingsStore,
  });

  const widgets = [];
  const result = await registeredTool.execute('tool-call', {
    action: 'start',
    tasks: [{ agent: 'helper', prompt: 'work' }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, 'done');
  assert.equal(result.details.sessions[0].agent, 'helper');
  assert.ok(widgets.length > 0);
  assert.equal(widgets.every(call => call[0] === 'subagent' && call[1] === undefined), true);
});

test('subagent tool forwards live manager DTOs to onUpdate and widget UI', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const runningSession = {
    id: 's1',
    sessionId: 's1',
    groupId: 'g1',
    agent: 'helper',
    status: 'running',
    resumable: false,
    promptPreview: 'work',
    messageSnippet: 'working',
    activeTool: 'read',
    turns: 1,
    toolUses: 1,
    createdAt: 1,
    startedAt: 1,
  };
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  const fakeManager = {
    sessions: [],
    async spawn(_pi, _ctx, _signal, _options, onUpdate) {
      onUpdate({ groupId: 'g1', sessions: [runningSession], active: true, updatedAt: 1 });
      return [{ agent: 'helper', prompt: 'work', status: 'completed', output: 'done', sessionId: 's1', resumable: false }];
    },
  };
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, { agentRegistry: fakeRegistry, agentManager: fakeManager });

  const partials = [];
  const widgets = [];
  const result = await registeredTool.execute('tool-call', {
    action: 'start',
    tasks: [{ agent: 'helper', prompt: 'work' }],
  }, undefined, partial => partials.push(partial), {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, 'done');
  assert.equal(result.details.sessions[0].activeTool, 'read');
  assert.equal(partials[0].details.sessions[0].activeTool, 'read');
  assert.match(partials[0].content[0].text, /working/);
  assert.equal(widgets[0][0], 'subagent');
  assert.match(widgets[0][1][0], /helper/);
  assert.deepEqual(widgets.at(-1), ['subagent', undefined, { placement: 'belowEditor' }]);
});

test('manager throttles live message snippets while lifecycle updates are immediate', async () => {
  const { AgentManager } = await import(`../dist/agent-manager.js?t=${unique()}`);
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  let finish;
  const allowFinish = new Promise(resolve => { finish = resolve; });
  const runner = async (_ctx, agent) => {
    agent.start(session);
    agent.messageUpdated('one');
    agent.messageUpdated('two');
    agent.messageUpdated('three');
    await allowFinish;
    agent.complete('done');
    return { response: 'done', session };
  };
  const manager = new AgentManager(registry, 1, runner);
  const updates = [];
  const pending = manager.spawn({}, { cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { agent: 'helper', prompt: 'work' },
  ], update => updates.push(update));

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(updates.some(update => update.sessions[0].status === 'running'));
  assert.equal(updates.filter(update => update.sessions[0].messageSnippet).length, 0);

  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(updates.filter(update => update.sessions[0].messageSnippet).length, 1);
  assert.equal(updates.at(-1).sessions[0].messageSnippet, 'three');

  finish();
  await pending;
});

test('subagent DTO render helpers collapse groups and expand every child row', async () => {
  const { formatSubagentToolLines } = await import(`../dist/subagent-ui.js?t=${unique()}`);
  const group = {
    id: 'g1',
    createdAt: 1_000,
    statusCounts: { completed: 1, running: 1, error: 1 },
    isError: true,
    sessions: [
      {
        id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', status: 'completed', resumable: false,
        promptPreview: 'first', turns: 1, toolUses: 0, createdAt: 1_000, startedAt: 1_000, completedAt: 2_000,
        finalOutcome: { status: 'completed' },
      },
      {
        id: 's2', sessionId: 's2', groupId: 'g1', agent: 'worker', status: 'running', resumable: false,
        promptPreview: 'second', activeTool: 'bash', messageSnippet: 'checking logs', turns: 2, toolUses: 1, createdAt: 1_000, startedAt: 2_000,
      },
      {
        id: 'g1:task-2', sessionId: 'g1:task-2', groupId: 'g1', agent: 'missing', status: 'error', resumable: false,
        promptPreview: 'third', turns: 0, toolUses: 0, createdAt: 1_000, completedAt: 1_000,
        finalOutcome: { status: 'error', message: 'Unknown agent: missing.' },
      },
    ],
  };

  const collapsed = formatSubagentToolLines({ group }, false, 4_000);
  assert.deepEqual(collapsed, ['3 subagents · 1 running · 1 completed · 1 error · outcome:error']);

  const expanded = formatSubagentToolLines({ group }, true, 4_000);
  assert.equal(expanded.length, 3);
  assert.match(expanded[0], /helper/);
  assert.match(expanded[1], /worker/);
  assert.match(expanded[1], /tool:bash/);
  assert.match(expanded[2], /missing/);
  assert.match(expanded[2], /Unknown agent: missing/);
});

test('subagent resume message keeps context concise while preserving structured result details', async () => {
  const { createSubagentResumeMessage } = await import(`../dist/subagent-ui.js?t=${unique()}`);
  const fullOutput = `done ${'x'.repeat(1500)} secret-tail`;
  const message = createSubagentResumeMessage({
    agent: 'helper',
    prompt: `follow up ${'y'.repeat(300)} prompt-tail`,
    status: 'completed',
    output: fullOutput,
    sessionId: 's1',
    resumable: true,
  });

  assert.equal(message.customType, 'subagent-resume');
  assert.equal(message.display, true);
  assert.match(message.content, /Subagent resume completed/);
  assert.match(message.content, /agent: helper/);
  assert.match(message.content, /session: s1/);
  assert.match(message.content, /prompt: follow up/);
  assert.match(message.content, /output: done/);
  assert.equal(message.content.includes('prompt-tail'), false);
  assert.equal(message.content.includes('secret-tail'), false);
  assert.ok(message.content.length < 700);
  assert.equal(message.details.result.output, fullOutput);
  assert.equal(message.details.promptPreview.includes('prompt-tail'), false);
  assert.equal(message.details.outputSnippet.includes('secret-tail'), false);
});

test('subagent DTO helpers allow resume only for completed resumable sessions', async () => {
  const { canResumeSubagentSession } = await import(`../dist/subagent-ui.js?t=${unique()}`);
  const base = {
    id: 's1', sessionId: 's1', groupId: 'g1', agent: 'helper', resumable: true,
    promptPreview: 'work', turns: 0, toolUses: 0, compactions: 0, createdAt: 1,
    availableActions: ['inspect'],
  };

  assert.equal(canResumeSubagentSession({ ...base, status: 'completed', availableActions: ['inspect', 'resume', 'clear'] }), true);
  for (const status of ['queued', 'running', 'error', 'aborted', 'interrupted', 'skipped']) {
    assert.equal(canResumeSubagentSession({ ...base, status, availableActions: ['inspect'] }), false, status);
  }
  assert.equal(canResumeSubagentSession({ ...base, status: 'completed', resumable: false, availableActions: ['inspect', 'clear'] }), false);
});

test('subagent DTO render helpers show compact operational progress and auto-hide empty widgets', async () => {
  const { formatSubagentSessionLine, formatWidgetLines } = await import(`../dist/subagent-ui.js?t=${unique()}`);
  const running = {
    id: 's1',
    sessionId: 's1',
    groupId: 'g1',
    agent: 'helper',
    status: 'running',
    resumable: false,
    promptPreview: 'do work',
    messageSnippet: 'reading source files',
    activeTool: 'read',
    turns: 2,
    toolUses: 1,
    createdAt: 1_000,
    startedAt: 1_000,
  };
  const line = formatSubagentSessionLine(running, 4_000);

  assert.match(line, /helper/);
  assert.match(line, /running/);
  assert.match(line, /tool:read/);
  assert.match(line, /2 turns/);
  assert.match(line, /3s/);
  assert.match(line, /reading source files/);
  assert.deepEqual(formatWidgetLines([running], 4_000), [line]);

  const completed = { ...running, status: 'completed', completedAt: 5_000, finalOutcome: { status: 'completed' } };
  assert.deepEqual(formatWidgetLines([completed], 6_000), []);
  assert.deepEqual(formatWidgetLines([{ ...completed, resumable: true }], 6_000).length, 1);
});

test('run-agent skips before prompting when signal aborts during setup', async () => {
  const controller = new AbortController();
  let createCalled = false;
  let promptCalled = false;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'should not prompt' }] }],
    subscribe() { return () => {}; },
    async prompt() { promptCalled = true; },
    abort() {},
  };
  const dependencies = {
    ResourceLoader: class { async reload() { controller.abort(); } },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => { createCalled = true; return { session }; },
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
  };
  const { RunAgent } = await import(`../dist/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project'
  }, { agent: 'helper', prompt: 'work' }, () => {});

  await assert.rejects(
    RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, controller.signal, dependencies),
    /Agent skipped/,
  );

  assert.equal(createCalled, false);
  assert.equal(promptCalled, false);
  assert.equal(agent.status.kind, 'skipped');
});

test('run-agent resolves relative task cwd against context cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-cwd-'));
  let loaderOptions;
  let createOptions;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const dependencies = {
    ResourceLoader: class { constructor(options) { loaderOptions = options; } async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async (options) => { createOptions = options; return { session }; },
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
  };
  const { RunAgent } = await import(`../dist/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project'
  }, { agent: 'helper', prompt: 'work', cwd: 'nested/project' }, () => {});

  await RunAgent({ cwd: root, modelRegistry: { getAll: () => [] } }, agent, undefined, dependencies);

  const expectedCwd = join(root, 'nested/project');
  assert.equal(loaderOptions.cwd, expectedCwd);
  assert.equal(createOptions.cwd, expectedCwd);
  assert.equal(createOptions.sessionManager.cwd, expectedCwd);
  assert.equal(createOptions.settingsManager.cwd, expectedCwd);
});

test('run-agent uses frontmatter thinking when task does not override it', async () => {
  let createOptions;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const dependencies = {
    ResourceLoader: class { async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async (options) => { createOptions = options; return { session }; },
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
  };
  const { RunAgent } = await import(`../dist/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'thinker', description: 'd', systemPrompt: 's', source: 'project', thinking: 'high'
  }, { agent: 'thinker', prompt: 'work' }, () => {});

  await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, undefined, dependencies);

  assert.equal(createOptions.thinkingLevel, 'high');
});

test('run-agent forwards configured tools allowlist to createAgentSession', async () => {
  let createOptions;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const dependencies = {
    ResourceLoader: class { async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async (options) => { createOptions = options; return { session }; },
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
  };
  const { RunAgent } = await import(`../dist/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'limited', description: 'd', systemPrompt: 's', source: 'project', tools: ['read', 'grep'], model: 'model-a'
  }, { agent: 'limited', prompt: 'work' }, () => {});

  const result = await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, undefined, dependencies);

  assert.equal(result.response, 'final');
  assert.deepEqual(createOptions.tools, ['read', 'grep']);
});

test('run-agent marks running parent cancellation as interrupted', async () => {
  const controller = new AbortController();
  let abortCalls = 0;
  let resolvePrompt;
  const session = {
    messages: [],
    subscribe() { return () => {}; },
    async prompt() { await new Promise(resolve => { resolvePrompt = resolve; }); },
    abort() {
      abortCalls += 1;
      session.messages = [{ role: 'assistant', stopReason: 'aborted', errorMessage: 'user cancelled', content: [{ type: 'text', text: 'partial' }] }];
      resolvePrompt?.();
    },
  };
  const dependencies = {
    ResourceLoader: class { async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => ({ session }),
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
  };
  const { RunAgent } = await import(`../dist/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project'
  }, { agent: 'helper', prompt: 'work' }, () => {});

  const pending = RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, controller.signal, dependencies);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(agent.status.kind, 'running');

  controller.abort();

  await assert.rejects(pending, /user cancelled/);
  assert.equal(abortCalls, 1);
  assert.equal(agent.status.kind, 'interrupted');
  assert.ok(agent.status.session);
});

test('run-agent treats final assistant error stop reason as failed child run', async () => {
  const session = {
    messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'model overloaded', content: [{ type: 'text', text: 'partial output' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const dependencies = {
    ResourceLoader: class { async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => ({ session }),
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
  };
  const { RunAgent } = await import(`../dist/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project'
  }, { agent: 'helper', prompt: 'work' }, () => {});

  await assert.rejects(
    RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, undefined, dependencies),
    /model overloaded/,
  );
  assert.equal(agent.status.kind, 'error');
  assert.equal(agent.status.error, 'model overloaded');
});
