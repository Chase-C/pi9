import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(run.stderr, '');
  assert.equal(run.exitCode, 1);
  assert.equal('task' in run, false);
});

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
