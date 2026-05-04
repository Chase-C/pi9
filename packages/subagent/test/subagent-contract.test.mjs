import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import subagentExtension from '../dist/index.js';

function registerExtension() {
  const registrations = { commands: new Map(), tools: new Map() };
  const pi = {
    registerCommand(name, command) {
      registrations.commands.set(name, command);
    },
    registerTool(tool) {
      registrations.tools.set(tool.name, tool);
    },
  };
  subagentExtension(pi);
  return registrations;
}

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function textOfLastUser(context) {
  const message = context.messages.findLast((candidate) => candidate.role === 'user');
  if (!message) return '';
  return Array.isArray(message.content)
    ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
    : message.content;
}

function registerTestProvider(modelRegistry, { id, name, streamSimple }) {
  modelRegistry.registerProvider('test-provider', {
    api: `test-${id}`,
    baseUrl: `memory://${id}`,
    apiKey: 'test-key',
    streamSimple,
    models: [
      {
        id,
        name,
        api: `test-${id}`,
        baseUrl: `memory://${id}`,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000,
      },
    ],
  });
}

function createEchoModelRegistry(onContext) {
  const authStorage = AuthStorage.inMemory({ 'test-provider': { type: 'api_key', key: 'test-key' } });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  registerTestProvider(modelRegistry, {
    id: 'echo',
    name: 'Echo',
    streamSimple(model, context) {
      onContext?.(context);
      const stream = createAssistantMessageEventStream();
      const prompt = textOfLastUser(context);
      const text = `echo: ${prompt}`;
      const partial = (contentText) => ({
        role: 'assistant',
        content: contentText === undefined ? [] : [{ type: 'text', text: contentText }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage(),
        stopReason: 'stop',
        timestamp: Date.now(),
      });
      const message = partial(text);
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: partial() });
        stream.push({ type: 'text_start', contentIndex: 0, partial: partial('') });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'echo: ', partial: partial('echo: ') });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: prompt, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
      });
      return stream;
    },
  });
  return modelRegistry;
}

function createDelayedModelRegistry(delayMs = 25) {
  const authStorage = AuthStorage.inMemory({ 'test-provider': { type: 'api_key', key: 'test-key' } });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const stats = { active: 0, maxActive: 0, started: [], finished: [] };

  registerTestProvider(modelRegistry, {
    id: 'delayed',
    name: 'Delayed',
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const prompt = textOfLastUser(context);
      const text = `done: ${prompt}`;
      const partial = (contentText) => ({
        role: 'assistant',
        content: contentText === undefined ? [] : [{ type: 'text', text: contentText }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage(),
        stopReason: 'stop',
        timestamp: Date.now(),
      });
      const message = partial(text);
      const isDelegatedTask = /^task \d+$/.test(prompt);

      if (isDelegatedTask) {
        stats.active += 1;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        stats.started.push(prompt);
      }
      setTimeout(() => {
        stream.push({ type: 'start', partial: partial() });
        stream.push({ type: 'text_start', contentIndex: 0, partial: partial('') });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        if (isDelegatedTask) {
          stats.finished.push(prompt);
          stats.active -= 1;
        }
      }, isDelegatedTask ? delayMs : 0);
      return stream;
    },
  });

  return { modelRegistry, stats };
}

async function withTempAgentDir(callback) {
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const temp = await mkdtemp(join(tmpdir(), 'pi-subagent-test-'));
  const agentDir = join(temp, 'agent');
  await mkdir(join(agentDir, 'agents'), { recursive: true });
  process.env.PI_AGENT_DIR = agentDir;
  try {
    return await callback({ temp, agentDir });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    await rm(temp, { recursive: true, force: true });
  }
}

async function writeAgent(agentDir, { name, description, model, tools, systemPrompt }) {
  const fields = [`name: ${name}`, `description: ${description}`];
  if (model) fields.push(`model: ${model}`);
  if (tools) fields.push(`tools: ${tools}`);
  await writeFile(join(agentDir, 'agents', `${name}.md`), `---\n${fields.join('\n')}\n---\n${systemPrompt}\n`);
}

test('subagent tool schema requires tasks with per-task prompt and optional agentScope only', () => {
  const { tools } = registerExtension();
  const tool = tools.get('subagent');

  assert.ok(tool, 'subagent tool should be registered');
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['agentScope', 'tasks']);
  assert.deepEqual(tool.parameters.required, ['tasks']);

  const taskSchema = tool.parameters.properties.tasks.items;
  assert.deepEqual(Object.keys(taskSchema.properties).sort(), ['agent', 'cwd', 'prompt']);
  assert.deepEqual(taskSchema.required.sort(), ['agent', 'prompt']);
});

test('missing tasks returns an error with available agents before any run', async () => {
  const { tools } = registerExtension();
  const result = await tools.get('subagent').execute('call-1', {}, undefined, undefined, { cwd: process.cwd() });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Provide a tasks array/);
  assert.match(result.content[0].text, /Available agents:/);
  assert.match(result.content[0].text, /planner|reviewer|scout/);
  assert.deepEqual(result.details.runs, []);
});

test('empty tasks returns an error with available agents before any run', async () => {
  const { tools } = registerExtension();
  const result = await tools.get('subagent').execute('call-1', { tasks: [] }, undefined, undefined, { cwd: process.cwd() });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Provide at least one task/);
  assert.match(result.content[0].text, /Available agents:/);
  assert.deepEqual(result.details.runs, []);
});

test('more than six tasks returns an error with available agents before any run', async () => {
  const { tools } = registerExtension();
  const tasks = Array.from({ length: 7 }, (_, index) => ({ agent: 'missing-agent', prompt: `prompt ${index}` }));
  const result = await tools.get('subagent').execute('call-1', { tasks }, undefined, undefined, { cwd: process.cwd() });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Too many tasks \(7\)\. Max is 6/);
  assert.match(result.content[0].text, /Available agents:/);
  assert.deepEqual(result.details.runs, []);
});

test('one-item tasks array is the single delegation path and details use prompt', async () => {
  const { tools } = registerExtension();
  const result = await tools.get('subagent').execute(
    'call-1',
    { tasks: [{ agent: 'missing-agent', prompt: 'inspect the code' }] },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.mode, 'tasks');
  assert.equal(result.details.runs.length, 1);
  const [run] = result.details.runs;
  assert.equal(run.agent, 'missing-agent');
  assert.equal(run.prompt, 'inspect the code');
  assert.equal(run.status, 'failed');
  assert.match(run.output, /Unknown agent: missing-agent/);
  assert.match(run.error, /Unknown agent: missing-agent/);
  assert.equal('stderr' in run, false);
  assert.equal('exitCode' in run, false);
  assert.equal('task' in run, false);
});

test('unknown agents synthesize failures without blocking other scheduled runs', async () => {
  const { tools } = registerExtension();
  const result = await tools.get('subagent').execute(
    'call-1',
    { tasks: [{ agent: 'missing-one', prompt: 'first' }, { agent: 'missing-two', prompt: 'second' }] },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  assert.equal(result.isError, true);
  assert.deepEqual(result.details.runs.map((run) => run.agent), ['missing-one', 'missing-two']);
  assert.deepEqual(result.details.runs.map((run) => run.status), ['failed', 'failed']);
  assert.match(result.details.runs[0].error, /Available agents: .*planner|reviewer|scout/);
  assert.match(result.details.runs[1].error, /Available agents: .*planner|reviewer|scout/);
  assert.match(result.content[0].text, /## missing-one — failed/);
  assert.match(result.content[0].text, /## missing-two — failed/);
});

test('known agents run through an in-memory SDK session with model, tools, and appended prompt', async () => withTempAgentDir(async ({ temp, agentDir }) => {
  await mkdir(join(temp, 'project'), { recursive: true });
  await writeAgent(agentDir, {
    name: 'echo',
    description: 'Echo test agent',
    model: 'test-provider/echo',
    tools: 'read,bash',
    systemPrompt: 'You are the echo agent.',
  });

  const contexts = [];
  const updates = [];
  const { tools } = registerExtension();
  const result = await tools.get('subagent').execute(
    'call-1',
    { tasks: [{ agent: 'echo', prompt: 'inspect the code', cwd: 'project' }] },
    undefined,
    (update) => updates.push(update),
    { cwd: temp, modelRegistry: createEchoModelRegistry((context) => contexts.push(context)) },
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.details.runs.length, 1);
  const [run] = result.details.runs;
  assert.equal(run.status, 'success');
  assert.equal(run.output, 'echo: inspect the code');
  assert.equal(run.model, 'test-provider/echo');
  assert.equal('stderr' in run, false);
  assert.equal('exitCode' in run, false);

  assert.ok(contexts.length >= 1);
  assert.match(contexts[0].systemPrompt, /You are the echo agent\./);
  assert.deepEqual(contexts[0].tools.map((tool) => tool.name).sort(), ['bash', 'read']);
  assert.ok(updates.some((update) => update.content[0].text.includes('echo: ')), 'live output should include streamed deltas');
}));

test('final task content includes full output while live updates stay truncated', async () => withTempAgentDir(async ({ temp, agentDir }) => {
  await writeAgent(agentDir, {
    name: 'echo',
    description: 'Echo test agent',
    model: 'test-provider/echo',
    systemPrompt: 'You are the echo agent.',
  });

  const prompt = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join('\n');
  const updates = [];
  const { tools } = registerExtension();
  const result = await tools.get('subagent').execute(
    'call-1',
    { tasks: [{ agent: 'echo', prompt }] },
    undefined,
    (update) => updates.push(update.content[0].text),
    { cwd: temp, modelRegistry: createEchoModelRegistry() },
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /## echo — success/);
  assert.match(result.content[0].text, /line 8/);
  assert.ok(updates.some((text) => text.includes('line 6')), 'live progress should include the first six output lines');
  assert.ok(updates.every((text) => !text.includes('line 7')), 'live progress should omit output after six lines');
  assert.ok(updates.every((text) => !text.includes('line 8')), 'live progress should omit output after six lines');
}));

test('batch execution preserves input order while running at most three sessions concurrently', async () => withTempAgentDir(async ({ temp, agentDir }) => {
  await writeAgent(agentDir, {
    name: 'delayed',
    description: 'Delayed test agent',
    model: 'test-provider/delayed',
    systemPrompt: 'You are the delayed agent.',
  });

  const tasks = Array.from({ length: 6 }, (_, index) => ({ agent: 'delayed', prompt: `task ${index + 1}` }));
  const { modelRegistry, stats } = createDelayedModelRegistry();
  const { tools } = registerExtension();
  const result = await tools.get('subagent').execute('call-1', { tasks }, undefined, undefined, { cwd: temp, modelRegistry });

  assert.equal(result.isError, undefined);
  assert.equal(stats.started.length, 6);
  assert.ok(stats.maxActive <= 3, `expected at most 3 active sessions, saw ${stats.maxActive}`);
  assert.deepEqual(result.details.runs.map((run) => run.prompt), tasks.map((task) => task.prompt));
  assert.deepEqual(result.details.runs.map((run) => run.output), tasks.map((task) => `done: ${task.prompt}`));
  assert.ok(result.content[0].text.indexOf('task 1') < result.content[0].text.indexOf('task 6'));
}));

test('top-level agent task cwd and chain are not supported delegation modes', async () => {
  const { tools } = registerExtension();
  const result = await tools.get('subagent').execute(
    'call-1',
    { agent: 'missing-agent', task: 'old shape', cwd: '/tmp', chain: [{ agent: 'missing-agent', task: 'old chain' }] },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Provide a tasks array/);
  assert.deepEqual(result.details.runs, []);
});
