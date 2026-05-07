import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const unique = () => `${Date.now()}-${Math.random()}`;

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

  const sessions = await registeredTool.execute('tool-call', {
    action: 'list',
    type: 'sessions',
  }, undefined, undefined, { cwd: root });
  assert.equal(sessions.isError, false);
  assert.deepEqual(sessions.details.sessions, []);
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
