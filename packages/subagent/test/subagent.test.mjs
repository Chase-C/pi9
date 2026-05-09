import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@mariozechner/pi-tui';

const unique = () => `${Date.now()}-${Math.random()}`;

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const TERMINAL_RESULT_KINDS = ['completed', 'error', 'interrupted', 'aborted', 'skipped'];

function fakeAgent({ config: configOverrides, options: optionsOverrides, status: statusOverride, activity: activityOverride, ...rest } = {}) {
  const cfg = { name: 'helper', description: '', source: 'project', resumable: false, ...configOverrides };
  const options = { agent: cfg.name, prompt: 'Fix issue', ...optionsOverrides };
  const baseStatus = statusOverride ?? { kind: 'completed', startedAt: 1, completedAt: 2, response: 'done' };

  let viewStatus;
  let ranSession;
  if (TERMINAL_RESULT_KINDS.includes(baseStatus.kind)) {
    const outcome = baseStatus.kind;
    const completedAt = baseStatus.completedAt ?? baseStatus.errorAt ?? baseStatus.skippedAt ?? baseStatus.interruptedAt ?? baseStatus.abortedAt ?? 2;
    const startedAt = baseStatus.startedAt;
    const snippet = outcome === 'completed'
      ? (baseStatus.response ?? 'done')
      : (baseStatus.error ?? `Agent ${outcome}.`);
    viewStatus = {
      kind: 'done',
      outcome,
      completedAt,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(snippet ? { snippet } : {}),
    };
    if ('session' in baseStatus) ranSession = baseStatus.session;
    else if (outcome === 'completed' || outcome === 'interrupted') ranSession = {};
  } else if (baseStatus.kind === 'running') {
    viewStatus = { kind: 'running', startedAt: baseStatus.startedAt ?? 1 };
  } else if (baseStatus.kind === 'queued') {
    viewStatus = { kind: 'queued' };
  } else {
    viewStatus = baseStatus;
    if (baseStatus.kind === 'done' && baseStatus.ran) ranSession = baseStatus.ran.session;
  }

  const resumable = cfg.resumable && (viewStatus.kind !== 'done' || Boolean(ranSession));
  const messageSnippet = rest.messageSnippet ?? rest.message;
  const turns = rest.turns ?? 0;
  const compactions = rest.compactions ?? 0;
  let toolHistory;
  if (activityOverride?.toolHistory) {
    toolHistory = activityOverride.toolHistory;
  } else if (rest.activeTools?.length) {
    toolHistory = rest.activeTools.map((name, i) => ({ id: `${name}-${i}`, name, startedAt: 1 }));
  } else if (rest.toolUses) {
    toolHistory = Array.from({ length: rest.toolUses }, (_, i) => ({
      id: `tool-${i}`, name: `tool-${i}`, startedAt: 1, completedAt: 2,
    }));
  } else {
    toolHistory = [];
  }

  return {
    id: rest.id ?? 's1',
    ...(rest.inputIndex !== undefined ? { inputIndex: rest.inputIndex } : {}),
    createdAt: rest.createdAt ?? 1,
    config: {
      name: cfg.name,
      description: cfg.description,
      source: cfg.source,
      sourcePath: cfg.sourcePath,
      model: options.model ?? cfg.model,
      thinking: options.thinking ?? cfg.thinking,
      tools: cfg.tools,
      resumable,
    },
    status: viewStatus,
    activity: {
      ...(messageSnippet ? { messageSnippet } : {}),
      turns,
      compactions,
      toolHistory,
    },
    usage: rest.totalUsage ?? rest.usage ?? ZERO_USAGE,
  };
}

test('Agent exposes the label from options and falls back to undefined when absent', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' };

  const labeled = new Agent('id1', 'group', config, { agent: 'helper', prompt: 'work', label: 'researcher' }, () => {});
  assert.equal(labeled.label, 'researcher');

  const unlabeled = new Agent('id2', 'group', config, { agent: 'helper', prompt: 'work' }, () => {});
  assert.equal(unlabeled.label, undefined);
});

test('Agent exposes the per-task skills array as-is and preserves undefined when absent', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' };

  const withSkills = new Agent('id1', 'group', config, { agent: 'helper', prompt: 'work', skills: ['tdd'] }, () => {});
  assert.deepEqual(withSkills.skills, ['tdd']);

  const explicitlyEmpty = new Agent('id2', 'group', config, { agent: 'helper', prompt: 'work', skills: [] }, () => {});
  assert.deepEqual(explicitlyEmpty.skills, []);

  const without = new Agent('id3', 'group', config, { agent: 'helper', prompt: 'work' }, () => {});
  assert.equal(without.skills, undefined);
});

test('Agent.toView surfaces the default skills from the agent config', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project', skills: ['foo', 'bar'] };

  const agent = new Agent('id', 'group', config, { agent: 'helper', prompt: 'work' }, () => {});
  assert.deepEqual(agent.toView().config.skills, ['foo', 'bar']);

  const noSkillsConfig = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' };
  const noSkills = new Agent('id2', 'group', noSkillsConfig, { agent: 'helper', prompt: 'work' }, () => {});
  assert.equal(noSkills.toView().config.skills, undefined);
});

test('Agent uses a per-task resumable false override before the config default', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project', resumable: true };

  const agent = new Agent('id', 'group', config, { agent: 'helper', prompt: 'work', resumable: false }, () => {});

  assert.equal(agent.resumable, false);
  assert.equal(agent.toView().config.resumable, false);
});

test('Agent uses a per-task resumable true override before the config default', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project', resumable: false };

  const agent = new Agent('id', 'group', config, { agent: 'helper', prompt: 'work', resumable: true }, () => {});

  assert.equal(agent.resumable, true);
  assert.equal(agent.toView().config.resumable, true);
});

test('subagent tool description mentions the optional label per-task field', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  assert.match(registeredTool.description, /label/);
});

test('subagent tool description mentions the per-task skills field and the skills listing type', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  assert.match(registeredTool.description, /skills/);
  assert.match(registeredTool.description, /unknown skill/i);
  assert.match(registeredTool.description, /type="skills"/);
});

test('subagent tool description mentions agent-frontmatter default skills and replace semantics', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  assert.match(registeredTool.description, /default skills/i);
  assert.match(registeredTool.description, /replace/i);
});

test('subagent tool description mentions the per-task resumable override is one-way', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  assert.match(registeredTool.description, /resumable/);
  assert.match(registeredTool.description, /one-way at completion/);
});

test('subagent renderCall shows labels when any task has one and falls back to count otherwise', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  const labeled = registeredTool.renderCall({
    action: 'run',
    tasks: [{ agent: 'helper', prompt: 'p1', label: 'researcher' }, { agent: 'helper', prompt: 'p2' }],
  }, undefined).text;
  assert.match(labeled, /researcher/);
  assert.doesNotMatch(labeled, /2 tasks/);

  const unlabeled = registeredTool.renderCall({
    action: 'run',
    tasks: [{ agent: 'helper', prompt: 'p1' }, { agent: 'helper', prompt: 'p2' }],
  }, undefined).text;
  assert.match(unlabeled, /2 tasks/);
});

test('display lines and widget prefer label over agent name when present', async () => {
  const { formatSubagentSessionLine, formatWidgetLines, formatSubagentSessionSummary } =
    await import(`../dist/view/format.js?t=${unique()}`);

  const labeled = fakeAgent({
    config: { name: 'helper', resumable: true },
    options: { prompt: 'work' },
    status: { kind: 'running', startedAt: 1 },
  });
  labeled.label = 'researcher';

  const unlabeled = fakeAgent({ config: { name: 'helper', resumable: true }, status: { kind: 'running', startedAt: 1 } });

  assert.match(formatSubagentSessionLine(labeled, 5_000), /researcher/);
  assert.doesNotMatch(formatSubagentSessionLine(labeled, 5_000), /helper/);
  assert.match(formatSubagentSessionLine(unlabeled, 5_000), /helper/);

  const widget = formatWidgetLines([labeled], 5_000).join('\n');
  assert.match(widget, /researcher/);
  assert.doesNotMatch(widget, /helper/);

  assert.match(formatSubagentSessionSummary(labeled), /researcher/);
  assert.doesNotMatch(formatSubagentSessionSummary(labeled), /helper/);
});

test('widget lists each visible session with labels and agent-name fallbacks', async () => {
  const { formatWidgetLines } = await import(`../dist/view/format.js?t=${unique()}`);

  const labeled = fakeAgent({
    id: 's1',
    config: { name: 'helper' },
    status: { kind: 'running', startedAt: 1_000 },
  });
  labeled.label = 'researcher';
  const unlabeled = fakeAgent({
    id: 's2',
    config: { name: 'writer' },
    status: { kind: 'running', startedAt: 1_000 },
  });
  const hiddenCompleted = fakeAgent({
    id: 's3',
    config: { name: 'auditor', resumable: false },
    status: { kind: 'completed', startedAt: 1_000, completedAt: 2_000, response: 'done' },
  });

  const widget = formatWidgetLines([labeled, unlabeled, hiddenCompleted], 5_000);

  assert.equal(widget.length, 2);
  assert.match(widget[0], /researcher/);
  assert.doesNotMatch(widget[0], /helper/);
  assert.match(widget[1], /writer/);
  assert.doesNotMatch(widget.join('\n'), /auditor/);
  assert.doesNotMatch(widget.join('\n'), /Subagents:/);
});

test('AgentManager.run carries the input label on unknown-agent synthetic results and views', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const registry = { agents: new Map() };
  const manager = new AgentManager(registry, 2, async () => ({ status: 'completed' }));

  let lastUpdate;
  const results = await manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [{ kind: 'spawn', agent: 'missing', prompt: 'do work', label: 'researcher' }],
    update => { lastUpdate = update; },
  );

  assert.equal(results[0].label, 'researcher');
  assert.equal(lastUpdate.sessions[0].label, 'researcher');
});

test('AgentRunResult propagates label from agent through completed/error/interrupted runs', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const { completedRun, errorRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' };

  const labeled = new Agent('id1', 'group', config, { agent: 'helper', prompt: 'work', label: 'researcher' }, () => {});
  assert.equal(completedRun(labeled, 'work', 'done').label, 'researcher');

  const labeledErr = new Agent('id2', 'group', config, { agent: 'helper', prompt: 'work', label: 'researcher' }, () => {});
  assert.equal(errorRun(labeledErr, 'work', 'fail').label, 'researcher');

  const labeledInt = new Agent('id3', 'group', config, { agent: 'helper', prompt: 'work', label: 'researcher' }, () => {});
  assert.equal(interruptedRun(labeledInt, 'work', 'stop').label, 'researcher');

  const unlabeled = new Agent('id4', 'group', config, { agent: 'helper', prompt: 'work' }, () => {});
  const result = completedRun(unlabeled, 'work', 'done');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'label'), false);
});

test('AgentRunResult resumable reflects the per-task override', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project', resumable: false };
  const session = { subscribe() { return () => {}; }, abort() {} };

  const agent = new Agent('id1', 'group', config, { agent: 'helper', prompt: 'work', resumable: true }, () => {});
  agent.attach(session);
  const result = completedRun(agent, 'work', 'done');

  assert.equal(result.resumable, true);
  assert.equal(result.sessionId, 'id1');
});

test('Agent.toView includes label when set and omits it otherwise', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' };

  const labeled = new Agent('id1', 'group', config, { agent: 'helper', prompt: 'work', label: 'researcher' }, () => {});
  assert.equal(labeled.toView().label, 'researcher');

  const unlabeled = new Agent('id2', 'group', config, { agent: 'helper', prompt: 'work' }, () => {});
  assert.equal(Object.prototype.hasOwnProperty.call(unlabeled.toView(), 'label'), false);
});

test('Agent.setLabel updates the label and emits a status update', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' };
  const updates = [];
  const agent = new Agent('id', 'group', config, { agent: 'helper', prompt: 'work' }, (_a, kind) => updates.push(kind));

  agent.setLabel('renamed');

  assert.equal(agent.label, 'renamed');
  assert.deepEqual(updates, ['status']);
});

test('TaskSchema accepts an optional label string and rejects non-string values', async () => {
  const { TaskSchema } = await import(`../dist/schema.js?t=${unique()}`);
  const { Check } = await import('typebox/value');

  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work' }), true);
  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work', label: 'researcher' }), true);
  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work', label: 42 }), false);
});

test('TaskSchema accepts an optional resumable boolean and rejects non-boolean values', async () => {
  const { TaskSchema } = await import(`../dist/schema.js?t=${unique()}`);
  const { Check } = await import('typebox/value');

  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work' }), true);
  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work', resumable: true }), true);
  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work', resumable: false }), true);
  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work', resumable: 'true' }), false);
});

test('TaskSchema accepts an optional skills string array and rejects non-string-array values', async () => {
  const { TaskSchema } = await import(`../dist/schema.js?t=${unique()}`);
  const { Check } = await import('typebox/value');

  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work' }), true);
  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work', skills: [] }), true);
  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work', skills: ['tdd', 'review'] }), true);
  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work', skills: 'tdd' }), false);
  assert.equal(Check(TaskSchema, { agent: 'helper', prompt: 'do work', skills: [42] }), false);
});

test('subagent UI settings default to below editor when file is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-settings-default-'));
  const { SubagentUiSettingsStore } = await import(`../dist/ui/settings.js?t=${unique()}`);
  const store = new SubagentUiSettingsStore(join(root, 'subagent', 'settings.json'));

  const result = await store.load();

  assert.deepEqual(result.settings, { widgetPlacement: 'belowEditor' });
  assert.equal(result.warning, undefined);
});

test('subagent UI settings save and reload widget placement globally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-settings-save-'));
  const settingsPath = join(root, 'subagent', 'settings.json');
  const { SubagentUiSettingsStore } = await import(`../dist/ui/settings.js?t=${unique()}`);

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
  const { SubagentUiSettingsStore } = await import(`../dist/ui/settings.js?t=${unique()}`);

  const result = await new SubagentUiSettingsStore(settingsPath).load();

  assert.deepEqual(result.settings, { widgetPlacement: 'belowEditor' });
  assert.match(result.warning, /widgetPlacement/);
});

test('registry loads markdown files from ctx cwd project dir and keys by frontmatter name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-registry-'));
  const projectAgents = join(root, '.pi', 'agents');
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, 'filename.md'), `---\nname: runtime-name\ndescription: Runtime description\nresumable: true\n---\nSystem prompt`);

  const { AgentRegistry } = await import(`../dist/domain/agent-registry.js?t=${unique()}`);
  const registry = new AgentRegistry();
  await registry.reload(root);

  assert.equal(registry.agents.has('filename'), false);
  assert.equal(registry.agents.get('runtime-name')?.systemPrompt, 'System prompt');
  assert.equal(registry.agents.get('runtime-name')?.resumable, true);
});

test('BuildAgentConfig parses CSV skills frontmatter and leaves skills undefined when absent', async () => {
  const { BuildAgentConfig } = await import(`../dist/domain/agent-config.js?t=${unique()}`);

  const withSkills = BuildAgentConfig(`---\nname: helper\ndescription: d\nskills: foo, bar\n---\nbody`, 'project');
  assert.deepEqual(withSkills.skills, ['foo', 'bar']);

  const withoutSkills = BuildAgentConfig(`---\nname: helper\ndescription: d\n---\nbody`, 'project');
  assert.equal(withoutSkills.skills, undefined);
});

test('agent transitions through start, finalize, and is idempotent on second finalize', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const { completedRun, errorRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const config = { name: 'agent', description: 'desc', systemPrompt: 'prompt', source: 'project' };
  const opts = { agent: 'agent', prompt: 'do work' };
  const session = { subscribe() { return () => {}; }, abort() {} };

  const running = new Agent('id', 'group', config, opts, () => {});
  running.attach(session);
  assert.equal(running.status.kind, 'running');
  assert.throws(() => running.attach(session), /Cannot attach/);

  completedRun(running, opts.prompt, 'done');
  assert.equal(running.status.kind, 'done');
  assert.equal(running.status.result.status, 'completed');
  assert.equal(running.status.result.output, 'done');

  errorRun(running, opts.prompt, 'late');
  assert.equal(running.status.result.status, 'completed', 'finalize is idempotent — terminal state is sticky');

  const queued = new Agent('q', 'group', config, opts, () => {});
  errorRun(queued, opts.prompt, 'failed before start');
  assert.equal(queued.status.kind, 'done');
  assert.equal(queued.status.result.status, 'error');
  assert.equal(queued.status.result.error, 'failed before start');
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
    action: 'run',
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

test('tool list action returns each agent default skills alongside tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-list-skills-default-'));
  const projectAgents = join(root, '.pi', 'agents');
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, 'helper.md'), `---\nname: helper\ndescription: Helps\ntools: read\nskills: foo, bar\n---\nHelp prompt`);

  let registeredTool;
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  const result = await registeredTool.execute('tool-call', {
    action: 'list',
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, false);
  const helper = result.details.agents.find(agent => agent.name === 'helper');
  assert.ok(helper);
  assert.deepEqual(helper.skills, ['foo', 'bar']);
  assert.deepEqual(helper.tools, ['read']);
});

test('tool list action with type=skills returns skills loaded from project .pi/skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-list-skills-'));
  const skillName = 'project-only-skill';
  const skillDir = join(root, '.pi', 'skills', skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Project-only skill body for listing\n---\nSkill body`);

  let registeredTool;
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  const result = await registeredTool.execute('tool-call', {
    action: 'list',
    type: 'skills',
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, false);
  assert.ok(Array.isArray(result.details.skills));
  const skill = result.details.skills.find(s => s.name === skillName);
  assert.ok(skill, `expected ${skillName} skill to be listed`);
  assert.equal(skill.description, 'Project-only skill body for listing');
  assert.equal(skill.source, 'project');
});

test('tool list action with an unrecognized type reports skills as a valid choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-list-bad-type-'));
  let registeredTool;
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  const result = await registeredTool.execute('tool-call', {
    action: 'list',
    type: 'whatever',
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /skills/);
});

test('tool run action returns full output only once in JSON details for a resume task', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const fullOutput = `resume output ${'q'.repeat(1500)} tail`;
  let registeredTool;
  const fakeManager = {
    sessions: [],
    run(_ctx, _signal, tasks) {
      return Promise.resolve(tasks.map(task => ({
        agent: 'helper',
        prompt: task.prompt,
        status: 'completed',
        output: fullOutput,
        sessionId: task.sessionId ?? 's1',
        resumable: true,
        resumed: task.kind === 'resume',
      })));
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
    action: 'run',
    tasks: [{ sessionId: 's1', prompt: 'follow up' }],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, fullOutput);
  assert.equal((result.content[0].text.match(new RegExp(fullOutput, 'g')) ?? []).length, 1);
});

test('/subagents settings exposes placement values, saves changes, and updates active widget', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const runningSession = fakeAgent({ status: { kind: 'running', startedAt: 1 }, turns: 1 });
  const fakeManager = {
    sessions: [runningSession],
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
  const runningSession = fakeAgent({ status: { kind: 'running', startedAt: 1 }, turns: 1 });
  const fakeManager = {
    sessions: [runningSession],
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

test('/subagents settings closes through injected cancel keybindings', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, {
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } },
    agentManager: { sessions: [] },
    settingsStore: { async load() { return { settings: { widgetPlacement: 'belowEditor' } }; }, async save() {} },
  });

  let closed = false;
  const theme = { fg: (_color, text) => text, bold: text => text };
  await commands.get('subagents').handler('settings', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory) {
        return new Promise(resolve => {
          const keybindings = { matches: (data, id) => data === 'q' && id === 'tui.select.cancel' };
          const component = factory({ requestRender() {} }, theme, keybindings, value => {
            closed = true;
            resolve(value);
          });
          component.handleInput('q');
          setImmediate(() => { if (!closed) resolve(undefined); });
        });
      },
    },
  });

  assert.equal(closed, true);
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

test('/subagents command closes agents and sessions menus on terminal escape sequences', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const theme = { fg: (_color, text) => text, bold: text => text };

  const agentsCommands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => agentsCommands.set(name, command),
  }, {
    agentRegistry: {
      agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project', resumable: false }]]),
      async reload() {},
      summarizeAgent() { return ''; },
    },
    agentManager: { sessions: [] },
  });

  let agentsClosed = false;
  await agentsCommands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory) {
        return new Promise(resolve => {
          const component = factory({ requestRender() {} }, theme, {}, value => {
            agentsClosed = true;
            resolve(value);
          });
          component.handleInput('\x1b[27u');
          setImmediate(() => { if (!agentsClosed) resolve(undefined); });
        });
      },
    },
  });

  const sessionsCommands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => sessionsCommands.set(name, command),
  }, {
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } },
    agentManager: {
      sessions: [fakeAgent({ status: { kind: 'completed', startedAt: 1, completedAt: 2, response: 'done' }, turns: 1 })],
      },
  });

  let sessionsClosed = false;
  await sessionsCommands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory) {
        return new Promise(resolve => {
          const component = factory({ requestRender() {} }, theme, {}, value => {
            sessionsClosed = true;
            resolve(value);
          });
          component.handleInput('\x1b[27u');
          setImmediate(() => { if (!sessionsClosed) resolve(undefined); });
        });
      },
    },
  });

  assert.equal(agentsClosed, true);
  assert.equal(sessionsClosed, true);
});

test('/subagents command reports custom UI failure without throwing', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const fakeRegistry = {
    agents: new Map(),
    async reload() {},
    summarizeAgent() { return ''; },
  };
  const fakeManager = {
    sessions: [fakeAgent({ config: { name: 'helper', resumable: true, source: 'project' }, status: { kind: 'completed', startedAt: 1, completedAt: 2, response: 'done' }, turns: 1 })],
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
    sessions: [fakeAgent({
      config: { resumable: true },
      options: { prompt: 'Fix issue by updating the API' },
    })],
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
  assert.doesNotMatch(text, /"config"/);
});

test('/subagents agents view constrains long rendered rows to the TUI width', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const width = 80;
  const fakeRegistry = {
    agents: new Map([
      ['researcher-with-a-long-name', {
        name: 'researcher-with-a-long-name',
        description: `Investigates broad design context with a very long description ${'y'.repeat(140)}`,
        source: 'project',
        resumable: true,
        model: 'test/model-with-a-long-name',
        tools: ['read', 'bash', 'grep'],
      }],
    ]),
    async reload() {},
    summarizeAgent() { return ''; },
  };
  const fakeManager = {
    sessions: [],
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: fakeRegistry, agentManager: fakeManager });

  let rendered = [];
  const theme = {
    fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
    bold: text => `\x1b[1m${text}\x1b[22m`,
  };
  await commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory) {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        rendered = component.render(width);
        return Promise.resolve(undefined);
      },
    },
  });

  assert.ok(rendered.length > 0);
  for (const line of rendered) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
});

test('/subagents sessions view constrains long rendered rows to the TUI width', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const width = 155;
  const fakeRegistry = {
    agents: new Map(),
    async reload() {},
    summarizeAgent() { return ''; },
  };
  const fakeManager = {
    sessions: [fakeAgent({
      config: { name: 'explorer' },
      options: { prompt: `Investigate the rendering crash caused by an extremely long prompt preview ${'x'.repeat(180)}` },
      status: { kind: 'running', startedAt: 1 },
      turns: 12,
    })],
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
  }, { agentRegistry: fakeRegistry, agentManager: fakeManager });

  let rendered = [];
  let inspectRendered = [];
  const theme = {
    fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
    bold: text => `\x1b[1m${text}\x1b[22m`,
  };
  await commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      custom(factory) {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        rendered = component.render(width);
        component.handleInput('\r');
        inspectRendered = component.render(width);
        return Promise.resolve(undefined);
      },
    },
  });

  assert.ok(rendered.length > 0);
  for (const line of rendered) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  assert.ok(inspectRendered.length > 0);
  for (const line of inspectRendered) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
});

test('/subagents command handles resume when editor UI is unavailable', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const fakeManager = {
    sessions: [fakeAgent({ config: { resumable: true } })],
    run() { throw new Error('run should not start'); },
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

test('/subagents command handles resume when editor UI throws', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let runCalls = 0;
  const fakeManager = {
    sessions: [fakeAgent({ config: { resumable: true } })],
    run() { runCalls += 1; throw new Error('run should not start'); },
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
      editor() { throw new Error('editor unavailable'); },
      custom(factory) {
        const theme = { fg: (_color, text) => text, bold: text => text };
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        component.handleInput('r');
        return Promise.resolve({ action: 'resume', sessionId: 's1', agent: 'helper' });
      },
    },
  }));

  assert.equal(runCalls, 0);
  assert.match(notifications.at(-1)[0], /editor|UI/i);
  assert.match(notifications.at(-1)[0], /editor unavailable/);
  assert.equal(notifications.at(-1)[1], 'warning');
});

test('subagents command resume loader constrains long rendered lines to the TUI width', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const width = 50;
  const longAgent = `helper-${'z'.repeat(120)}`;
  const fakeManager = {
    sessions: [fakeAgent({ config: { name: longAgent, resumable: true } })],
    run(_ctx, _signal, tasks) {
      return Promise.resolve(tasks.map(task => ({ agent: longAgent, prompt: task.prompt, status: 'completed', output: 'done', sessionId: task.sessionId, resumable: true, resumed: true })));
    },
  };
  const commands = new Map();
  subagentExtension({
    registerTool() {},
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer() {},
    sendMessage() {},
  }, { agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } }, agentManager: fakeManager });

  let customCalls = 0;
  let loaderLines = [];
  const theme = {
    fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
    bold: text => `\x1b[1m${text}\x1b[22m`,
  };
  await commands.get('subagents').handler('', {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify() {},
      setWidget() {},
      editor() { return Promise.resolve('follow up'); },
      custom(factory) {
        customCalls += 1;
        return new Promise(resolve => {
          let component;
          const done = value => {
            component?.dispose?.();
            resolve(value);
          };
          component = factory({ requestRender() {} }, theme, {}, done);
          if (customCalls === 1) {
            component.handleInput('r');
          } else {
            loaderLines = component.render(width);
          }
        });
      },
    },
  });

  assert.equal(customCalls, 2);
  assert.ok(loaderLines.length > 0);
  for (const line of loaderLines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
});

test('subagents command resumes completed retained session with editor loader and visible concise message', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const resumeCalls = [];
  const fakeManager = {
    sessions: [fakeAgent({ config: { resumable: true } })],
    run(_ctx, signal, tasks) {
      const task = tasks[0];
      resumeCalls.push({ signal, sessionId: task.sessionId, prompt: task.prompt });
      return Promise.resolve([{ agent: 'helper', prompt: task.prompt, status: 'completed', output: `Result ${'z'.repeat(1000)}`, sessionId: task.sessionId, resumable: true, resumed: true }]);
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
  const fakeManager = {
    sessions: [fakeAgent({ config: { resumable: true } })],
    run(_ctx, signal, tasks) {
      const task = tasks[0];
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          resolve([{ agent: 'helper', prompt: task.prompt, status: 'interrupted', error: 'Agent interrupted.', sessionId: task.sessionId, resumable: true, resumed: true }]);
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
          if (customCalls === 2) component.handleInput('\x1b[27u');
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
  const retainedSession = fakeAgent({
    config: { resumable: true, tools: ['read', 'bash'] },
    options: { prompt: 'Fix retained context', model: 'test/model', thinking: 'low' },
    status: { kind: 'completed', startedAt: 2_000, completedAt: 5_000, response: 'Implemented the retained-session fix.' },
    turns: 3, toolUses: 2, compactions: 1, createdAt: 1_000,
    totalUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  });
  const clearCalls = [];
  const fakeManager = {
    sessions: [retainedSession],
    clear(sessionId) {
      clearCalls.push(sessionId);
      this.sessions = this.sessions.filter(session => session.id !== sessionId);
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
  assert.match(inspectText, /Actions: inspect, resume, clear/);
  assert.deepEqual(clearCalls, ['s1']);
  assert.deepEqual(fakeManager.sessions, []);
  assert.match(notifications.at(-1)[0], /Cleared subagent session s1/);
});

test('subagent tool lists retained sessions as serialized DTOs with clear action', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    return completedRun(agent, prompt, 'The final answer from the child.');
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
    action: 'run',
    tasks: [{ agent: 'chatty', prompt: 'Remember this work.' }],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false, modelRegistry: { getAll: () => [] } });

  const result = await registeredTool.execute('tool-call', {
    action: 'list',
    type: 'sessions',
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, false);
  assert.equal(result.details.sessions.length, 1);
  const retained = result.details.sessions[0];
  assert.equal(retained.config.name, 'chatty');
  assert.equal(retained.status.kind, 'done');
  assert.equal(retained.status.outcome, 'completed');
  assert.equal(retained.config.source, 'project');
  assert.equal(retained.config.model, 'test/model');
  assert.deepEqual(retained.config.tools, ['read']);
  assert.equal(retained.status.snippet, 'The final answer from the child.');
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
          id: 's1', inputIndex: 0, createdAt: 1,
          config: { name: 'helper', description: 'Helper', source: 'project', model: undefined, thinking: undefined, tools: undefined, resumable: false },
          status: { kind: 'done', outcome: 'completed', completedAt: 2 },
          activity: { turns: 1, compactions: 0, toolHistory: [] },
          usage: undefined,
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
    action: 'run',
    tasks: [{ agent: 'missing', prompt: 'do work' }],
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.deepEqual(result.details.results.map(r => r.agent), ['missing']);
  assert.equal(result.details.results[0].status, 'error');
  assert.match(result.content[0].text, /"results"/);
});

test('manager returns ordered per-run output and reports unknown agents and child failures', async () => {
  const calls = [];
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const runner = async (_ctx, agent, prompt) => {
    calls.push(prompt);
    if (prompt === 'three') throw new Error('child failed');
    const session = { messages: [], subscribe: () => () => {}, async prompt() {}, abort() {} };
    agent.attach(session);
    return completedRun(agent, prompt, `response:${prompt}`);
  };

  const registry = { agents: new Map([
    ['good', { name: 'good', description: 'd', systemPrompt: 's', source: 'project' }],
    ['bad', { name: 'bad', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const manager = new AgentManager(registry, 2, runner);
  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'good', prompt: 'one', model: 'm1' },
    { kind: 'spawn', agent: 'missing', prompt: 'two' },
    { kind: 'spawn', agent: 'bad', prompt: 'three' },
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
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const runner = async () => {
    throw new Error('setup failed before start');
  };
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const manager = new AgentManager(registry, 1, runner);
  const updates = [];

  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'helper', prompt: 'work' },
  ], update => updates.push(update));

  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /setup failed before start/);
  const final = updates.at(-1);
  assert.equal(final.active, false);
  assert.equal(final.sessions.length, 1);
  assert.equal(final.sessions[0].status.kind, 'done');
  assert.equal(final.sessions[0].status.outcome, 'error');
  assert.match(final.sessions[0].status.snippet, /setup failed before start/);
  assert.deepEqual(manager.sessions, []);
});

test('manager returns skipped result and final group row for queued task whose signal aborted before it can start', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const calls = [];
  let finishFirst;
  const firstCanFinish = new Promise(resolve => { finishFirst = resolve; });
  const runner = async (_ctx, agent, prompt) => {
    calls.push(prompt);
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    agent.attach(session);
    if (prompt === 'one') await firstCanFinish;
    return completedRun(agent, prompt, `done:${prompt}`);
  };
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const manager = new AgentManager(registry, 1, runner);
  const controller = new AbortController();
  const updates = [];

  const pending = manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, controller.signal, [
    { kind: 'spawn', agent: 'helper', prompt: 'one' },
    { kind: 'spawn', agent: 'helper', prompt: 'two' },
  ], update => updates.push(update));

  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  finishFirst();
  const results = await pending;

  assert.deepEqual(calls, ['one']);
  assert.equal(results[0].status, 'completed');
  assert.equal(results[1].status, 'skipped');
  assert.equal(results[1].resumable, false);
  const final = updates.at(-1);
  assert.deepEqual(final.sessions.map(s => s.status.kind === 'done' ? s.status.outcome : s.status.kind), ['completed', 'skipped']);
  assert.deepEqual(manager.sessions, []);
});

test('manager does not expose skipped resumable tasks as sessions', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  let finishFirst;
  const firstCanFinish = new Promise(resolve => { finishFirst = resolve; });
  const runner = async (_ctx, agent, prompt) => {
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    agent.attach(session);
    await firstCanFinish;
    return completedRun(agent, prompt, 'done');
  };
  const registry = { agents: new Map([
    ['blocker', { name: 'blocker', description: 'd', systemPrompt: 's', source: 'project', resumable: false }],
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 1, runner);
  const controller = new AbortController();

  const pending = manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, controller.signal, [
    { kind: 'spawn', agent: 'blocker', prompt: 'one' },
    { kind: 'spawn', agent: 'chatty', prompt: 'two' },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  finishFirst();
  const results = await pending;

  assert.equal(results[1].status, 'skipped');
  assert.equal(results[1].resumable, false);
  assert.equal(Object.prototype.hasOwnProperty.call(results[1], 'sessionId'), false);
  assert.deepEqual(manager.sessions, []);
  assert.deepEqual(manager.clear(), { cleared: 0 });
});

test('manager does not expose or resume non-resumable completed sessions', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const runner = async (_ctx, agent, prompt) => {
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    agent.attach(session);
    return completedRun(agent, prompt, 'done');
  };
  const registry = { agents: new Map([
    ['oneshot', { name: 'oneshot', description: 'd', systemPrompt: 's', source: 'project', resumable: false }],
  ]) };
  const manager = new AgentManager(registry, 1, runner);

  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'oneshot', prompt: 'work' },
  ]);

  assert.equal(results[0].status, 'completed');
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], 'sessionId'), false);
  assert.deepEqual(manager.sessions, []);
  const [retried] = await manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [{ kind: 'resume', sessionId: 'anything', prompt: 'follow up' }],
  );
  assert.equal(retried.status, 'error');
  assert.equal(retried.resumed, true);
  assert.match(retried.error, /Unknown resumable subagent session/);
});

test('manager discards a completed session when a task overrides resumable to false', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const runner = async (_ctx, agent, prompt) => {
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    agent.attach(session);
    return completedRun(agent, prompt, 'done');
  };
  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 1, runner);

  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'work', resumable: false },
  ]);

  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].resumable, false);
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], 'sessionId'), false);
  assert.deepEqual(manager.sessions, []);
  assert.deepEqual(manager.clear(), { cleared: 0 });
});

test('manager retains only resumable interrupted sessions inspect-clear only after parent cancellation settles', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const runner = async (_ctx, agent, prompt, signal) => {
    const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
    agent.attach(session);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return interruptedRun(agent, prompt, 'cancelled by parent');
  };
  const registry = { agents: new Map([
    ['oneshot', { name: 'oneshot', description: 'd', systemPrompt: 's', source: 'project', resumable: false }],
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 2, runner);
  const controller = new AbortController();

  const pending = manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, controller.signal, [
    { kind: 'spawn', agent: 'oneshot', prompt: 'one' },
    { kind: 'spawn', agent: 'chatty', prompt: 'two' },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  const results = await pending;

  assert.deepEqual(results.map(result => result.status), ['interrupted', 'interrupted']);
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], 'sessionId'), false);
  assert.ok(results[1].sessionId);

  const sessions = manager.sessions;
  assert.deepEqual(sessions.map(session => session.config.name), ['chatty']);
  assert.equal(sessions[0].status.kind, 'done');
  assert.equal(sessions[0].status.outcome, 'interrupted');

  const [retried] = await manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [{ kind: 'resume', sessionId: results[1].sessionId, prompt: 'follow up' }],
  );
  assert.equal(retried.status, 'error');
  assert.equal(retried.resumed, true);
  assert.match(retried.error, /while it is interrupted/);
  assert.deepEqual(manager.clear(results[1].sessionId), { cleared: 1, sessionId: results[1].sessionId });
  assert.deepEqual(manager.sessions, []);
});

test('manager retains a completed session when a task overrides resumable to true', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    return completedRun(agent, prompt, `done:${prompt}`);
  };
  const resumeRunner = async (_ctx, agent, prompt) => {
    agent.attach(agent.status.ran.session);
    return completedRun(agent, prompt, `follow:${prompt}`);
  };
  const registry = { agents: new Map([
    ['oneshot', { name: 'oneshot', description: 'd', systemPrompt: 's', source: 'project', resumable: false }],
  ]) };
  const manager = new AgentManager(registry, 1, runner, resumeRunner);

  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'oneshot', prompt: 'work', resumable: true },
  ]);

  assert.equal(results[0].resumable, true);
  assert.ok(results[0].sessionId);
  assert.deepEqual(manager.sessions.map(session => [session.id, session.config.name, session.config.resumable]), [
    [results[0].sessionId, 'oneshot', true],
  ]);

  const [resumed] = await manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [{ kind: 'resume', sessionId: results[0].sessionId, prompt: 'again' }],
  );
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.output, 'follow:again');
});

test('manager retains, resumes, lists, and clears completed resumable sessions', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  let runEmit;
  let resumeEmit;
  const runner = async (_ctx, agent, prompt) => {
    const session = {
      messages: [],
      subscribe(handler) { runEmit = handler; return () => { runEmit = undefined; }; },
      async prompt() {},
      abort() {},
    };
    agent.attach(session);
    runEmit({ type: 'turn_end' });
    return completedRun(agent, prompt, `response:${prompt}`);
  };
  const resumeRunner = async (_ctx, agent, prompt) => {
    agent.attach(agent.status.ran.session);
    resumeEmit = runEmit;
    resumeEmit({ type: 'turn_end' });
    return completedRun(agent, prompt, `follow:${prompt}`);
  };

  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 2, runner, resumeRunner);
  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'one' },
  ]);

  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].output, 'response:one');
  assert.ok(results[0].sessionId);

  assert.deepEqual(manager.sessions.map(session => session.id), [results[0].sessionId]);

  const [resumed] = await manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [{ kind: 'resume', sessionId: results[0].sessionId, prompt: 'two' }],
  );
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.output, 'follow:two');
  assert.equal(resumed.prompt, 'two');
  assert.equal(resumed.sessionId, results[0].sessionId);

  const retained = manager.sessions[0];
  assert.equal(retained.id, results[0].sessionId);
  assert.equal(retained.status.kind, 'done');
  assert.equal(retained.status.outcome, 'completed');
  assert.equal(retained.status.snippet, 'follow:two');

  assert.deepEqual(manager.clear(results[0].sessionId), { cleared: 1, sessionId: results[0].sessionId });
  assert.deepEqual(manager.sessions, []);
});

test('manager rejects duplicate resume tasks without corrupting the retained session', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    return completedRun(agent, prompt, `old:${prompt}`);
  };
  let finishResume;
  const resumeCanFinish = new Promise(resolve => { finishResume = resolve; });
  const resumePrompts = [];
  const resumeRunner = async (_ctx, agent, prompt) => {
    resumePrompts.push(prompt);
    if (prompt !== 'first follow-up') throw new Error(`duplicate resume runner invoked for ${prompt}`);
    agent.attach(agent.status.ran.session);
    await resumeCanFinish;
    return completedRun(agent, prompt, `new:${prompt}`);
  };
  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 2, runner, resumeRunner);
  const [first] = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'initial prompt' },
  ]);

  const pending = manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [
      { kind: 'resume', sessionId: first.sessionId, prompt: 'first follow-up' },
      { kind: 'resume', sessionId: first.sessionId, prompt: 'duplicate follow-up' },
    ],
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(resumePrompts, ['first follow-up']);
  finishResume();

  const [resumed, duplicate] = await pending;
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.output, 'new:first follow-up');
  assert.equal(resumed.sessionId, first.sessionId);

  assert.equal(duplicate.status, 'error');
  assert.equal(duplicate.prompt, 'duplicate follow-up');
  assert.equal(duplicate.resumed, true);
  assert.equal(duplicate.sessionId, first.sessionId);
  assert.match(duplicate.error, /already.*resum/i);

  assert.equal(manager.sessions.length, 1);
  assert.equal(manager.sessions[0].id, first.sessionId);
  assert.equal(manager.sessions[0].status.kind, 'done');
  assert.equal(manager.sessions[0].status.outcome, 'completed');
  assert.equal(manager.sessions[0].status.snippet, 'new:first follow-up');
});

test('manager reports resume setup failure as the follow-up prompt error without returning prior completion', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    return completedRun(agent, prompt, `old:${prompt}`);
  };
  const resumeRunner = async () => {
    throw new Error('resume setup exploded');
  };
  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 1, runner, resumeRunner);
  const [first] = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'initial prompt' },
  ]);

  const [resumed] = await manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [{ kind: 'resume', sessionId: first.sessionId, prompt: 'follow-up prompt' }],
  );

  assert.equal(resumed.status, 'error');
  assert.equal(resumed.prompt, 'follow-up prompt');
  assert.match(resumed.error, /resume setup exploded/);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.output, undefined);
  assert.notEqual(resumed.status, first.status);
  assert.notEqual(resumed.output, first.output);
});

test('manager keeps a retained completed session retryable after resume setup failure', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    return completedRun(agent, prompt, `old:${prompt}`);
  };
  let resumeAttempts = 0;
  const resumeRunner = async (_ctx, agent, prompt) => {
    resumeAttempts += 1;
    if (resumeAttempts === 1) throw new Error('resume setup exploded');
    agent.attach(agent.status.ran.session);
    return completedRun(agent, prompt, `new:${prompt}`);
  };
  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 1, runner, resumeRunner);
  const [first] = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'initial prompt' },
  ]);

  const [failed] = await manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [{ kind: 'resume', sessionId: first.sessionId, prompt: 'failed follow-up' }],
  );
  assert.equal(failed.status, 'error');

  assert.equal(manager.sessions.length, 1);
  assert.equal(manager.sessions[0].id, first.sessionId);
  assert.equal(manager.sessions[0].status.kind, 'done');
  assert.equal(manager.sessions[0].status.outcome, 'completed');
  assert.equal(manager.sessions[0].status.snippet, 'old:initial prompt');

  const [retried] = await manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [{ kind: 'resume', sessionId: first.sessionId, prompt: 'successful follow-up' }],
  );
  assert.equal(retried.status, 'completed');
  assert.equal(retried.output, 'new:successful follow-up');
  assert.equal(retried.prompt, 'successful follow-up');
  assert.equal(retried.sessionId, first.sessionId);
});

test('manager reports queued cancelled resume as skipped follow-up and keeps retained session retryable', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  let finishBlocker;
  const blockerCanFinish = new Promise(resolve => { finishBlocker = resolve; });
  const makeSession = () => ({ messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} });
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(makeSession());
    if (prompt === 'blocker prompt') await blockerCanFinish;
    return completedRun(agent, prompt, `output:${prompt}`);
  };
  const resumeRunner = async (_ctx, agent, prompt) => {
    agent.attach(agent.status.ran.session);
    return completedRun(agent, prompt, `resumed:${prompt}`);
  };
  const registry = { agents: new Map([
    ['blocker', { name: 'blocker', description: 'd', systemPrompt: 's', source: 'project', resumable: false }],
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 1, runner, resumeRunner);
  const [first] = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'initial prompt' },
  ]);

  const controller = new AbortController();
  const updates = [];
  const pending = manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    controller.signal,
    [
      { kind: 'spawn', agent: 'blocker', prompt: 'blocker prompt' },
      { kind: 'resume', sessionId: first.sessionId, prompt: 'follow-up prompt', resumable: false },
    ],
    update => updates.push(update),
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  finishBlocker();
  const results = await pending;
  const resumed = results[1];

  assert.equal(resumed.status, 'skipped');
  assert.equal(resumed.prompt, 'follow-up prompt');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.output, undefined);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(resumed.resumable, true);
  assert.notEqual(resumed.output, first.output);

  const finalResumeView = updates.at(-1).sessions[1];
  assert.equal(finalResumeView.resumed, true);
  assert.equal(finalResumeView.status.kind, 'done');
  assert.equal(finalResumeView.status.outcome, 'skipped');
  assert.equal(finalResumeView.status.snippet, 'Agent skipped.');
  assert.equal(finalResumeView.config.resumable, true);

  assert.equal(manager.sessions.length, 1);
  assert.equal(manager.sessions[0].id, first.sessionId);
  assert.equal(manager.sessions[0].status.kind, 'done');
  assert.equal(manager.sessions[0].status.outcome, 'completed');
  assert.equal(manager.sessions[0].status.snippet, 'output:initial prompt');

  const [retried] = await manager.run(
    { cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
    undefined,
    [{ kind: 'resume', sessionId: first.sessionId, prompt: 'retry prompt' }],
  );
  assert.equal(retried.status, 'completed');
  assert.equal(retried.output, 'resumed:retry prompt');
  assert.equal(retried.sessionId, first.sessionId);
});

test('agent re-subscribes on resume so events during a resumed cycle update its state', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  let emit;
  const session = {
    messages: [],
    subscribe(handler) { emit = handler; return () => { emit = undefined; }; },
    async prompt() {},
    abort() {},
  };
  const agent = new Agent('id', 'gid', { name: 'a', description: 'd', systemPrompt: '', source: 'project', resumable: true }, { agent: 'a', prompt: 'p' }, () => {});

  agent.attach(session);
  emit({ type: 'turn_end' });
  assert.equal(agent.turns, 1);
  completedRun(agent, 'p', 'done');
  assert.equal(emit, undefined, 'subscription should be torn down on complete');

  agent.attach(session);
  assert.ok(emit, 'resume should re-subscribe');
  emit({ type: 'turn_end' });
  emit({ type: 'tool_execution_start', toolName: 'read' });
  assert.equal(agent.turns, 2);
  assert.equal(agent.toolUses, 1);
  completedRun(agent, 'p2', 'done2');
  assert.equal(emit, undefined, 'subscription should be torn down on complete after resume');
});

test('agent stores tool-use history and keeps active tool correct for overlapping executions', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const session = {
    messages: [],
    subscribe(handler) { this.emit = handler; return () => { this.emit = undefined; }; },
    async prompt() {},
    abort() {},
  };
  const agent = new Agent('id', 'gid', { name: 'a', description: 'd', systemPrompt: '', source: 'project' }, { agent: 'a', prompt: 'p' }, () => {});

  agent.attach(session);
  session.emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read' });
  session.emit({ type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash' });
  assert.deepEqual(agent.activeTools, ['read', 'bash']);

  session.emit({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', isError: false });
  assert.deepEqual(agent.activeTools, ['bash']);
  assert.equal(agent.toolUses, 2);
  assert.deepEqual(agent.toolHistory.map(tool => [tool.id, tool.name, Boolean(tool.completedAt), tool.isError]), [
    ['read-1', 'read', true, false],
    ['bash-1', 'bash', false, undefined],
  ]);
});

test('manager emits grouped progress rows in input order including unknown agents', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    return completedRun(agent, prompt, `done:${prompt}`);
  };
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const manager = new AgentManager(registry, 2, runner);
  const snapshots = [];

  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'helper', prompt: 'one' },
    { kind: 'spawn', agent: 'missing', prompt: 'two' },
    { kind: 'spawn', agent: 'helper', prompt: 'three' },
  ], update => snapshots.push(update.sessions));

  assert.deepEqual(results.map(result => result.agent), ['helper', 'missing', 'helper']);
  assert.deepEqual(results.map(result => result.status), ['completed', 'error', 'completed']);

  const initial = snapshots[0];
  assert.equal(initial.length, 3);
  assert.deepEqual(initial.map(row => [row.config.name, row.status.kind === 'done' ? row.status.outcome : row.status.kind, row.inputIndex]), [
    ['helper', 'queued', 0],
    ['missing', 'error', 1],
    ['helper', 'queued', 2],
  ]);
  assert.match(initial[1].status.snippet, /Unknown agent: missing/);
});

test('manager emits live agent progress with the right transitions', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project', model: 'test/model' }],
  ]) };
  let emit;
  const session = { messages: [], subscribe(handler) { emit = handler; return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    emit({ type: 'message_start' });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working through the delegated task' } });
    emit({ type: 'tool_execution_start', toolName: 'read' });
    emit({ type: 'turn_end' });
    emit({ type: 'tool_execution_end' });
    return completedRun(agent, prompt, 'done');
  };
  const manager = new AgentManager(registry, 1, runner);
  const snapshots = [];

  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'helper', prompt: 'Summarize the project status for the parent agent.' },
  ], update => snapshots.push(update.sessions[0]));

  assert.equal(results[0].status, 'completed');
  assert.ok(snapshots.length >= 4);
  assert.equal(snapshots[0].status.kind, 'queued');
  assert.equal(snapshots[0].config.name, 'helper');

  assert.ok(snapshots.some(s => s.status.kind === 'running'));
  assert.ok(snapshots.some(s => s.activity.toolHistory.some(tool => tool.name === 'read' && tool.completedAt === undefined)));
  assert.ok(snapshots.some(s => s.activity.turns === 1));
  assert.ok(snapshots.some(s => s.activity.messageSnippet === 'working through the delegated task'));
  assert.equal(snapshots.at(-1).status.outcome, 'completed');
});

test('subagent tool returns one ordered final group for mixed success, unknown, and failed children', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    if (agent.agentName === 'flaky') throw new Error('flaky failed');
    return completedRun(agent, prompt, `done:${prompt}`);
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
    action: 'run',
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
  assert.deepEqual(result.details.group.sessions.map(s => s.config.name), ['helper', 'missing', 'flaky']);
  assert.deepEqual(result.details.group.sessions.map(s => s.status.kind === 'done' ? s.status.outcome : s.status.kind), ['completed', 'error', 'error']);
  assert.equal(result.details.group.statusCounts.completed, 1);
  assert.equal(result.details.group.statusCounts.error, 2);
  assert.equal(result.details.group.isError, true);
});

test('subagent tool notifies invalid settings fallback without breaking execution', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const runningAgent = fakeAgent({ status: { kind: 'running', startedAt: 1 }, turns: 1 });
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  const fakeManager = {
    sessions: [],
    async run(_ctx, _signal, _tasks, onUpdate) {
      onUpdate({ sessions: [runningAgent], active: true });
      return [{ agent: 'helper', prompt: 'work', status: 'completed', output: 'done', sessionId: 's1', resumable: false, resumed: false }];
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
    action: 'run',
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
  const runningAgent = fakeAgent({ status: { kind: 'running', startedAt: 1 }, turns: 1 });
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  const fakeManager = {
    sessions: [],
    async run(_ctx, _signal, _tasks, onUpdate) {
      onUpdate({ sessions: [runningAgent], active: true });
      return [{ agent: 'helper', prompt: 'work', status: 'completed', output: 'done', sessionId: 's1', resumable: false, resumed: false }];
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
    action: 'run',
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
  const runningAgent = fakeAgent({ status: { kind: 'running', startedAt: 1 }, message: 'working', turns: 1 });
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  const fakeManager = {
    sessions: [runningAgent],
    async run(_ctx, _signal, _tasks, onUpdate) {
      onUpdate({ sessions: [runningAgent], active: true });
      return [{ agent: 'helper', prompt: 'work', status: 'completed', output: 'done', sessionId: 's1', resumable: false, resumed: false }];
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
    action: 'run',
    tasks: [{ agent: 'helper', prompt: 'work' }],
  }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, 'done');
  assert.equal(result.details.group.sessions[0].config.name, 'helper');
  assert.ok(widgets.length > 0);
  assert.equal(widgets.every(call => call[0] === 'subagent' && call[1] === undefined), true);
});

test('subagent tool forwards live manager updates to onUpdate and widget UI', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  const runningAgent = fakeAgent({
    status: { kind: 'running', startedAt: 1 },
    message: 'working',
    activeTools: ['read'],
    turns: 1,
    toolUses: 1,
  });
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  const fakeManager = {
    sessions: [],
    async run(_ctx, _signal, _tasks, onUpdate) {
      onUpdate({ sessions: [runningAgent], active: true });
      return [{ agent: 'helper', prompt: 'work', status: 'completed', output: 'done', sessionId: 's1', resumable: false, resumed: false }];
    },
  };
  const fakeSettingsStore = {
    async load() { return { settings: { widgetPlacement: 'belowEditor' } }; },
    async save() {},
  };
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, { agentRegistry: fakeRegistry, agentManager: fakeManager, settingsStore: fakeSettingsStore });

  const partials = [];
  const widgets = [];
  const result = await registeredTool.execute('tool-call', {
    action: 'run',
    tasks: [{ agent: 'helper', prompt: 'work' }],
  }, undefined, partial => partials.push(partial), {
    cwd: process.cwd(),
    hasUI: true,
    ui: { setWidget: (...args) => widgets.push(args), notify() {} },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, 'done');
  assert.equal(result.details.group.sessions[0].activity.toolHistory.at(-1)?.name, 'read');
  assert.equal(partials[0].details.group.sessions[0].activity.toolHistory.at(-1)?.name, 'read');
  assert.match(partials[0].content[0].text, /working/);
  assert.equal(widgets[0][0], 'subagent');
  assert.match(widgets[0][1][0], /helper/);
  assert.deepEqual(widgets.at(-1), ['subagent', undefined, { placement: 'belowEditor' }]);
});

test('manager throttles live message snippets while lifecycle updates are immediate', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun, interruptedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const registry = { agents: new Map([
    ['helper', { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  let emit;
  const session = { messages: [], subscribe(handler) { emit = handler; return () => {}; }, async prompt() {}, abort() {} };
  let finish;
  const allowFinish = new Promise(resolve => { finish = resolve; });
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    emit({ type: 'message_start' });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'one' } });
    emit({ type: 'message_start' });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'two' } });
    emit({ type: 'message_start' });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'three' } });
    await allowFinish;
    return completedRun(agent, prompt, 'done');
  };
  const manager = new AgentManager(registry, 1, runner);
  const snapshots = [];
  const pending = manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'helper', prompt: 'work' },
  ], update => snapshots.push(update.sessions[0]));

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(snapshots.some(s => s.status.kind === 'running'));
  assert.equal(snapshots.filter(s => s.activity.messageSnippet).length, 0);

  await new Promise(resolve => setTimeout(resolve, 130));
  const withMessage = snapshots.filter(s => s.activity.messageSnippet);
  assert.equal(withMessage.length, 1);
  assert.equal(snapshots.at(-1).activity.messageSnippet, 'three');

  finish();
  await pending;
});

test('subagent DTO render helpers collapse groups and expand every child row', async () => {
  const { formatSubagentToolLines } = await import(`../dist/view/format.js?t=${unique()}`);
  const group = {
    statusCounts: { completed: 1, running: 2, error: 1 },
    isError: true,
    sessions: [
      {
        id: 's1', inputIndex: 0, createdAt: 1_000,
        config: { name: 'helper', source: 'project', model: undefined, thinking: undefined, tools: undefined, resumable: false },
        status: { kind: 'done', outcome: 'completed', startedAt: 1_000, completedAt: 2_000 },
        activity: { turns: 1, compactions: 0, toolHistory: [] },
        usage: undefined,
      },
      {
        id: 's2', inputIndex: 1, createdAt: 1_000,
        config: { name: 'worker', source: 'project', model: undefined, thinking: undefined, tools: undefined, resumable: false },
        status: { kind: 'running', startedAt: 2_000 },
        activity: { messageSnippet: 'checking logs', turns: 2, compactions: 0, toolHistory: [{ id: 'bash-1', name: 'bash', startedAt: 2_500 }] },
        usage: undefined,
      },
      {
        id: 'g1:task-2', inputIndex: 2, createdAt: 1_000,
        config: { name: 'missing', source: undefined, model: undefined, thinking: undefined, tools: undefined, resumable: false },
        status: { kind: 'done', outcome: 'error', completedAt: 1_000, snippet: 'Unknown agent: missing.' },
        activity: { turns: 0, compactions: 0, toolHistory: [] },
        usage: undefined,
      },
      {
        id: 's4', inputIndex: 3, createdAt: 1_000,
        config: { name: 'worker2', source: 'project', model: undefined, thinking: undefined, tools: undefined, resumable: false },
        status: { kind: 'running', startedAt: 2_000 },
        activity: { messageSnippet: 'searching', turns: 1, compactions: 0, toolHistory: [{ id: 'grep-1', name: 'grep', startedAt: 2_500 }] },
        usage: undefined,
      },
    ],
  };

  const collapsed = formatSubagentToolLines({ group }, false, 4_000);
  assert.deepEqual(collapsed, ['4 subagents · 2 running · 1 completed · 1 error · outcome:error']);

  const expanded = formatSubagentToolLines({ group }, true, 4_000);
  assert.equal(expanded.length, 4);
  assert.match(expanded[0], /helper/);
  assert.match(expanded[1], /worker/);
  assert.match(expanded[1], /tool:bash/);
  assert.match(expanded[2], /missing/);
  assert.match(expanded[2], /Unknown agent: missing/);
  assert.match(expanded[3], /worker2/);
  assert.match(expanded[3], /tool:grep/);
});

test('subagent resume message keeps context concise while preserving structured result details', async () => {
  const { createSubagentResumeMessage } = await import(`../dist/view/resume-message.js?t=${unique()}`);
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

test('canResumeSubagentSession allows resume only for completed resumable agents', async () => {
  const { canResumeSubagentSession } = await import(`../dist/view/view-helpers.js?t=${unique()}`);

  assert.equal(canResumeSubagentSession(fakeAgent({ config: { resumable: true } })), true);
  assert.equal(canResumeSubagentSession(fakeAgent({ config: { resumable: false } })), false);

  const nonCompleted = [
    { kind: 'queued' },
    { kind: 'running', startedAt: 1 },
    { kind: 'error', startedAt: 1, errorAt: 2, error: 'e', session: {} },
    { kind: 'aborted', startedAt: 1, abortedAt: 2, session: {} },
    { kind: 'interrupted', startedAt: 1, interruptedAt: 2, session: {} },
    { kind: 'skipped', skippedAt: 1 },
  ];
  for (const status of nonCompleted) {
    assert.equal(canResumeSubagentSession(fakeAgent({ config: { resumable: true }, status })), false, status.kind);
  }
});

test('format helpers render compact operational progress and auto-hide empty widgets', async () => {
  const { formatSubagentSessionLine, formatWidgetLines } = await import(`../dist/view/format.js?t=${unique()}`);
  const running = fakeAgent({
    status: { kind: 'running', startedAt: 1_000 },
    message: 'reading source files',
    activeTools: ['read'],
    turns: 2,
    createdAt: 1_000,
  });
  const line = formatSubagentSessionLine(running, 4_000);

  assert.match(line, /helper/);
  assert.match(line, /running/);
  assert.match(line, /tool:read/);
  assert.match(line, /2 turns/);
  assert.match(line, /3s/);
  assert.match(line, /reading source files/);
  assert.deepEqual(formatWidgetLines([running], 4_000), [line]);

  const completed = fakeAgent({ status: { kind: 'completed', startedAt: 1_000, completedAt: 5_000, response: 'done' } });
  assert.deepEqual(formatWidgetLines([completed], 6_000), []);

  const completedResumable = fakeAgent({ config: { resumable: true }, status: { kind: 'completed', startedAt: 1_000, completedAt: 5_000, response: 'done' } });
  assert.equal(formatWidgetLines([completedResumable], 6_000).length, 1);
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
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project'
  }, { agent: 'helper', prompt: 'work' }, () => {});

  const result = await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', controller.signal, dependencies);

  assert.equal(result.status, 'skipped');
  assert.match(result.error, /Agent skipped/);
  assert.equal(createCalled, false);
  assert.equal(promptCalled, false);
  assert.equal(agent.status.kind, 'done');
  assert.equal(agent.status.result.status, 'skipped');
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
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project'
  }, { agent: 'helper', prompt: 'work', cwd: 'nested/project' }, () => {});

  await RunAgent({ cwd: root, modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

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
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'thinker', description: 'd', systemPrompt: 's', source: 'project', thinking: 'high'
  }, { agent: 'thinker', prompt: 'work' }, () => {});

  await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

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
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'limited', description: 'd', systemPrompt: 's', source: 'project', tools: ['read', 'grep'], model: 'model-a'
  }, { agent: 'limited', prompt: 'work' }, () => {});

  const result = await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  assert.equal(result.output, 'final');
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
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project'
  }, { agent: 'helper', prompt: 'work' }, () => {});

  const pending = RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', controller.signal, dependencies);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(agent.status.kind, 'running');

  controller.abort();

  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.match(result.error, /user cancelled/);
  assert.equal(abortCalls, 1);
  assert.equal(agent.status.kind, 'done');
  assert.equal(agent.status.result.status, 'interrupted');
  assert.ok(agent.status.ran?.session);
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
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project'
  }, { agent: 'helper', prompt: 'work' }, () => {});

  const result = await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  assert.equal(result.status, 'error');
  assert.match(result.error, /model overloaded/);
  assert.equal(agent.status.kind, 'done');
  assert.equal(agent.status.result.status, 'error');
  assert.equal(agent.status.result.error, 'model overloaded');
});

test('run-agent injects requested skills into the system prompt and disables loader skill scanning', async () => {
  let loaderOptions;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const skill = {
    name: 'tdd',
    description: 'Test-driven development',
    filePath: '/skills/tdd/SKILL.md',
    baseDir: '/skills/tdd',
    sourceInfo: { path: '/skills/tdd/SKILL.md', source: 'local', scope: 'project', origin: 'top-level' },
    disableModelInvocation: false,
  };
  const dependencies = {
    ResourceLoader: class { constructor(options) { loaderOptions = options; } async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => ({ session }),
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
    loadSkills: () => ({ skills: [skill], diagnostics: [] }),
  };
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 'BASE PROMPT', source: 'project'
  }, { agent: 'helper', prompt: 'work', skills: ['tdd'] }, () => {});

  const result = await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  assert.equal(result.status, 'completed');
  assert.equal(loaderOptions.noSkills, true);
  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /^BASE PROMPT/);
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /<name>tdd<\/name>/);
  assert.match(prompt, /<description>Test-driven development<\/description>/);
});

test('run-agent includes a disable-model-invocation skill when explicitly named', async () => {
  let loaderOptions;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const skill = {
    name: 'review',
    description: 'Review pending changes',
    filePath: '/skills/review/SKILL.md',
    baseDir: '/skills/review',
    sourceInfo: { path: '/skills/review/SKILL.md', source: 'local', scope: 'user', origin: 'top-level' },
    disableModelInvocation: true,
  };
  const dependencies = {
    ResourceLoader: class { constructor(options) { loaderOptions = options; } async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => ({ session }),
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
    loadSkills: () => ({ skills: [skill], diagnostics: [] }),
  };
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 'BASE', source: 'project'
  }, { agent: 'helper', prompt: 'work', skills: ['review'] }, () => {});

  await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /<name>review<\/name>/);
});

test('run-agent reports an unknown skill as a failed run without starting a session', async () => {
  let createCalled = false;
  const dependencies = {
    ResourceLoader: class { async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => { createCalled = true; return { session: { subscribe() { return () => {}; }, async prompt() {}, abort() {}, messages: [] } }; },
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
    loadSkills: () => ({ skills: [], diagnostics: [] }),
  };
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project'
  }, { agent: 'helper', prompt: 'work', skills: ['missing'] }, () => {});

  const result = await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  assert.equal(result.status, 'error');
  assert.match(result.error, /missing/);
  assert.equal(createCalled, false);
  assert.equal(agent.status.kind, 'done');
  assert.equal(agent.status.result.status, 'error');
});

test('run-agent uses agent-frontmatter default skills when the task does not provide skills', async () => {
  let loaderOptions;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const skill = {
    name: 'foo',
    description: 'Default foo skill',
    filePath: '/skills/foo/SKILL.md',
    baseDir: '/skills/foo',
    sourceInfo: { path: '/skills/foo/SKILL.md', source: 'local', scope: 'project', origin: 'top-level' },
    disableModelInvocation: false,
  };
  const dependencies = {
    ResourceLoader: class { constructor(options) { loaderOptions = options; } async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => ({ session }),
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
    loadSkills: () => ({ skills: [skill], diagnostics: [] }),
  };
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 'BASE PROMPT', source: 'project', skills: ['foo']
  }, { agent: 'helper', prompt: 'work' }, () => {});

  const result = await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  assert.equal(result.status, 'completed');
  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /^BASE PROMPT/);
  assert.match(prompt, /<name>foo<\/name>/);
});

test('run-agent per-task skills fully replace agent-frontmatter default skills', async () => {
  let loaderOptions;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const skills = [
    { name: 'foo', description: 'foo skill', filePath: '/skills/foo/SKILL.md', baseDir: '/skills/foo',
      sourceInfo: { path: '/skills/foo/SKILL.md', source: 'local', scope: 'project', origin: 'top-level' },
      disableModelInvocation: false },
    { name: 'bar', description: 'bar skill', filePath: '/skills/bar/SKILL.md', baseDir: '/skills/bar',
      sourceInfo: { path: '/skills/bar/SKILL.md', source: 'local', scope: 'project', origin: 'top-level' },
      disableModelInvocation: false },
    { name: 'baz', description: 'baz skill', filePath: '/skills/baz/SKILL.md', baseDir: '/skills/baz',
      sourceInfo: { path: '/skills/baz/SKILL.md', source: 'local', scope: 'project', origin: 'top-level' },
      disableModelInvocation: false },
  ];
  const dependencies = {
    ResourceLoader: class { constructor(options) { loaderOptions = options; } async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => ({ session }),
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
    loadSkills: () => ({ skills, diagnostics: [] }),
  };
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 'BASE', source: 'project', skills: ['foo', 'baz']
  }, { agent: 'helper', prompt: 'work', skills: ['bar'] }, () => {});

  await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /<name>bar<\/name>/);
  assert.doesNotMatch(prompt, /<name>foo<\/name>/);
  assert.doesNotMatch(prompt, /<name>baz<\/name>/);
});

test('run-agent explicit empty per-task skills opts out of agent-frontmatter defaults', async () => {
  let loaderOptions;
  let loadSkillsCalls = 0;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const dependencies = {
    ResourceLoader: class { constructor(options) { loaderOptions = options; } async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => ({ session }),
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
    loadSkills: () => { loadSkillsCalls += 1; return { skills: [], diagnostics: [] }; },
  };
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 'BASE PROMPT', source: 'project', skills: ['foo']
  }, { agent: 'helper', prompt: 'work', skills: [] }, () => {});

  await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  assert.equal(loaderOptions.systemPromptOverride(), 'BASE PROMPT');
  assert.equal(loadSkillsCalls, 0, 'should not load skills when the task explicitly opted out');
});

test('run-agent reports an unknown skill from agent-frontmatter defaults as a failed run', async () => {
  let createCalled = false;
  const dependencies = {
    ResourceLoader: class { async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => { createCalled = true; return { session: { subscribe() { return () => {}; }, async prompt() {}, abort() {}, messages: [] } }; },
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
    loadSkills: () => ({ skills: [], diagnostics: [] }),
  };
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 's', source: 'project', skills: ['ghost']
  }, { agent: 'helper', prompt: 'work' }, () => {});

  const result = await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  assert.equal(result.status, 'error');
  assert.match(result.error, /ghost/);
  assert.equal(createCalled, false);
});

test('run-agent leaves the system prompt unchanged when no skills are requested', async () => {
  let loaderOptions;
  let loadSkillsCalls = 0;
  const session = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }],
    subscribe() { return () => {}; },
    async prompt() {},
    abort() {},
  };
  const dependencies = {
    ResourceLoader: class { constructor(options) { loaderOptions = options; } async reload() {} },
    getAgentDir: () => '/tmp/pi-agent',
    createAgentSession: async () => ({ session }),
    sessionManager: cwd => ({ cwd }),
    settingsManager: (cwd, agentDir) => ({ cwd, agentDir }),
    loadSkills: () => { loadSkillsCalls += 1; return { skills: [], diagnostics: [] }; },
  };
  const { RunAgent } = await import(`../dist/runtime/run-agent.js?t=${unique()}`);
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const agent = new Agent('id', 'group', {
    name: 'helper', description: 'd', systemPrompt: 'BASE PROMPT', source: 'project'
  }, { agent: 'helper', prompt: 'work' }, () => {});

  await RunAgent({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, agent, 'p', undefined, dependencies);

  assert.equal(loaderOptions.systemPromptOverride(), 'BASE PROMPT');
  assert.equal(loadSkillsCalls, 0, 'should not load skills when none are requested');
});

test('parseTask classifies a task carrying sessionId as a resume request and preserves resume fields', async () => {
  const { parseTask } = await import(`../dist/schema.js?t=${unique()}`);

  const parsed = parseTask({
    sessionId: 'sess-1',
    prompt: 'follow up',
    label: 'phase 2',
    resumable: false,
  });

  assert.deepEqual(parsed, {
    kind: 'resume',
    sessionId: 'sess-1',
    prompt: 'follow up',
    label: 'phase 2',
    resumable: false,
  });
});

test('parseTask rejects a task that carries both agent and sessionId', async () => {
  const { parseTask } = await import(`../dist/schema.js?t=${unique()}`);
  const result = parseTask({ agent: 'helper', sessionId: 's', prompt: 'p' });
  assert.ok('error' in result);
  assert.match(result.error, /both agent and sessionId/);
});

test('parseTask rejects a task that carries neither agent nor sessionId', async () => {
  const { parseTask } = await import(`../dist/schema.js?t=${unique()}`);
  const result = parseTask({ prompt: 'p' });
  assert.ok('error' in result);
  assert.match(result.error, /exactly one of agent .* or sessionId/);
});

test('parseTask rejects a resume task that carries spawn-only fields', async () => {
  const { parseTask } = await import(`../dist/schema.js?t=${unique()}`);
  for (const field of ['model', 'thinking', 'cwd', 'skills']) {
    const value = field === 'skills' ? ['tdd'] : 'whatever';
    const result = parseTask({ sessionId: 's', prompt: 'p', [field]: value });
    assert.ok('error' in result, `expected ${field} to be rejected`);
    assert.match(result.error, new RegExp(`rejects ${field}`));
  }
});

test('parseTask rejects an empty prompt and unstructured tasks', async () => {
  const { parseTask } = await import(`../dist/schema.js?t=${unique()}`);
  const empty = parseTask({ agent: 'helper', prompt: '   ' });
  assert.ok('error' in empty);
  assert.match(empty.error, /non-empty/);

  const noObj = parseTask(null);
  assert.ok('error' in noObj);
  assert.match(noObj.error, /must be an object/);
});

test('parseTask rejects skills entries that are not non-empty strings', async () => {
  const { parseTask } = await import(`../dist/schema.js?t=${unique()}`);
  const result = parseTask({ agent: 'helper', prompt: 'p', skills: ['', 'x'] });
  assert.ok('error' in result);
  assert.match(result.error, /skills entries/);

  const notArray = parseTask({ agent: 'helper', prompt: 'p', skills: 'tdd' });
  assert.ok('error' in notArray);
  assert.match(notArray.error, /skills must be an array/);
});

test('parseTask classifies a task carrying agent as a spawn request and preserves spawn fields', async () => {
  const { parseTask } = await import(`../dist/schema.js?t=${unique()}`);

  const parsed = parseTask({
    agent: 'helper',
    prompt: 'do work',
    label: 'researcher',
    skills: ['tdd'],
    resumable: true,
    model: 'm',
    thinking: 'high',
    cwd: 'sub',
  });

  assert.deepEqual(parsed, {
    kind: 'spawn',
    agent: 'helper',
    prompt: 'do work',
    label: 'researcher',
    skills: ['tdd'],
    resumable: true,
    model: 'm',
    thinking: 'high',
    cwd: 'sub',
  });
});

test('manager.run handles a mixed batch of one spawn and one resume in input order with resumed flags set correctly', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => {
    agent.attach(session);
    return completedRun(agent, prompt, `spawn:${prompt}`);
  };
  const resumeRunner = async (_ctx, agent, prompt) => {
    agent.attach(agent.status.ran.session);
    return completedRun(agent, prompt, `resume:${prompt}`, true);
  };
  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
    ['fresh', { name: 'fresh', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 2, runner, resumeRunner);

  const [seed] = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'first' },
  ]);
  assert.equal(seed.status, 'completed');
  assert.equal(seed.resumed, false);
  assert.ok(seed.sessionId);

  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'fresh', prompt: 'two' },
    { kind: 'resume', sessionId: seed.sessionId, prompt: 'three' },
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].agent, 'fresh');
  assert.equal(results[0].resumed, false);
  assert.equal(results[0].output, 'spawn:two');
  assert.equal(results[1].agent, 'chatty');
  assert.equal(results[1].resumed, true);
  assert.equal(results[1].output, 'resume:three');
  assert.equal(results[1].sessionId, seed.sessionId);
});

test('manager.run resume task with a new label overwrites the agent stored label', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => { agent.attach(session); return completedRun(agent, prompt, 'first'); };
  const resumeRunner = async (_ctx, agent, prompt) => { agent.attach(agent.status.ran.session); return completedRun(agent, prompt, 'second', true); };
  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 1, runner, resumeRunner);

  const [seed] = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'one', label: 'phase-1' },
  ]);

  await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'resume', sessionId: seed.sessionId, prompt: 'two', label: 'phase-2' },
  ]);

  assert.equal(manager.sessions[0].label, 'phase-2');
});

test('manager.run resume task with resumable: false discards the session after completion', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => { agent.attach(session); return completedRun(agent, prompt, 'first'); };
  const resumeRunner = async (_ctx, agent, prompt) => { agent.attach(agent.status.ran.session); return completedRun(agent, prompt, 'second', true); };
  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 1, runner, resumeRunner);

  const [seed] = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'one' },
  ]);
  assert.equal(manager.sessions.length, 1);

  const [resumed] = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'resume', sessionId: seed.sessionId, prompt: 'two', resumable: false },
  ]);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.resumable, false);
  assert.deepEqual(manager.sessions, []);
});

test('manager.run resume task targeting an unknown sessionId yields a per-task error and does not block siblings', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => { agent.attach(session); return completedRun(agent, prompt, `done:${prompt}`); };
  const registry = { agents: new Map([
    ['fresh', { name: 'fresh', description: 'd', systemPrompt: 's', source: 'project' }],
  ]) };
  const manager = new AgentManager(registry, 2, runner);

  const results = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'resume', sessionId: 'nonexistent', prompt: 'ghost' },
    { kind: 'spawn', agent: 'fresh', prompt: 'real' },
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'error');
  assert.equal(results[0].resumed, true);
  assert.match(results[0].error, /Unknown resumable subagent session: nonexistent/);
  assert.equal(results[1].status, 'completed');
  assert.equal(results[1].resumed, false);
  assert.equal(results[1].output, 'done:real');
});

test('subagent action=run dispatches a spawn-only batch through agentManager.run with resumed flags', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let runCalls = 0;
  let receivedTasks;
  const fakeManager = {
    sessions: [],
    async run(_ctx, _signal, tasks) {
      runCalls += 1;
      receivedTasks = tasks;
      return tasks.map(task => ({
        agent: task.agent ?? '(unknown)',
        prompt: task.prompt,
        status: 'completed',
        output: `done:${task.prompt}`,
        resumable: false,
        resumed: task.kind === 'resume',
      }));
    },
  };
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, {
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: 'belowEditor' } }; } },
  });

  const result = await registeredTool.execute('tool-call', {
    action: 'run',
    tasks: [{ agent: 'helper', prompt: 'work' }],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(runCalls, 1);
  assert.equal(receivedTasks.length, 1);
  assert.equal(receivedTasks[0].kind, 'spawn');
  assert.equal(receivedTasks[0].agent, 'helper');
  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].output, 'done:work');
  assert.equal(result.details.results[0].resumed, false);
});

test('subagent action=run accepts a heterogeneous batch of spawn and resume tasks', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let receivedTasks;
  const fakeManager = {
    sessions: [],
    async run(_ctx, _signal, tasks) {
      receivedTasks = tasks;
      return tasks.map(task => ({
        agent: task.kind === 'spawn' ? task.agent : 'chatty',
        prompt: task.prompt,
        status: 'completed',
        output: `done:${task.prompt}`,
        resumable: task.kind === 'resume',
        resumed: task.kind === 'resume',
        ...(task.kind === 'resume' ? { sessionId: task.sessionId } : {}),
      }));
    },
  };
  const fakeRegistry = {
    agents: new Map([['helper', { name: 'helper', description: 'Helps', source: 'project' }]]),
    async reload() {},
    summarizeAgent() { return 'helper (project)'; },
  };
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, {
    agentRegistry: fakeRegistry,
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: 'belowEditor' } }; } },
  });

  const result = await registeredTool.execute('tool-call', {
    action: 'run',
    tasks: [
      { agent: 'helper', prompt: 'one' },
      { sessionId: 's-1', prompt: 'two' },
    ],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, false);
  assert.deepEqual(receivedTasks.map(t => t.kind), ['spawn', 'resume']);
  assert.equal(receivedTasks[1].sessionId, 's-1');
  assert.equal(result.details.results[0].resumed, false);
  assert.equal(result.details.results[1].resumed, true);
});

test('subagent action=run rejects a task carrying both agent and sessionId at parse time', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let runCalls = 0;
  const fakeManager = {
    sessions: [],
    async run() { runCalls += 1; return []; },
  };
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, {
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } },
    agentManager: fakeManager,
    settingsStore: { async load() { return { settings: { widgetPlacement: 'belowEditor' } }; } },
  });

  const result = await registeredTool.execute('tool-call', {
    action: 'run',
    tasks: [{ agent: 'helper', sessionId: 's', prompt: 'p' }],
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, true);
  assert.equal(runCalls, 0);
  assert.match(result.content[0].text, /both agent and sessionId/);
});

test('subagent action=resume is no longer recognized', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } }, {
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ''; } },
    agentManager: { sessions: [] },
  });

  const result = await registeredTool.execute('tool-call', {
    action: 'resume',
    sessionId: 'whatever',
    prompt: 'follow up',
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown action/);
  assert.match(result.content[0].text, /run/);
});

test('subagent tool description documents the unified run surface and mutual exclusion', async () => {
  const { default: subagentExtension } = await import(`../dist/index.js?t=${unique()}`);
  let registeredTool;
  subagentExtension({ registerTool: tool => { registeredTool = tool; } });

  assert.match(registeredTool.description, /action="run"/);
  assert.doesNotMatch(registeredTool.description, /action="start"/);
  assert.doesNotMatch(registeredTool.description, /action="resume"/);
  assert.match(registeredTool.description, /sessionId/);
  assert.match(registeredTool.description, /agent/);
  assert.match(registeredTool.description, /mutually exclusive|reject/i);
});

test('manager.run partial updates flag resumed entries on the rendered AgentView', async () => {
  const { AgentManager } = await import(`../dist/runtime/agent-manager.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);
  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const runner = async (_ctx, agent, prompt) => { agent.attach(session); return completedRun(agent, prompt, 'first'); };
  const resumeRunner = async (_ctx, agent, prompt) => { agent.attach(agent.status.ran.session); return completedRun(agent, prompt, 'second', true); };
  const registry = { agents: new Map([
    ['chatty', { name: 'chatty', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
    ['fresh', { name: 'fresh', description: 'd', systemPrompt: 's', source: 'project', resumable: true }],
  ]) };
  const manager = new AgentManager(registry, 2, runner, resumeRunner);

  const [seed] = await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'chatty', prompt: 'one' },
  ]);

  const updates = [];
  await manager.run({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } }, undefined, [
    { kind: 'spawn', agent: 'fresh', prompt: 'two' },
    { kind: 'resume', sessionId: seed.sessionId, prompt: 'three' },
  ], update => updates.push(update));

  const final = updates.at(-1);
  assert.equal(final.sessions.length, 2);
  assert.equal(final.sessions[0].resumed, false);
  assert.equal(final.sessions[1].resumed, true);
});

test('formatSubagentSessionLine adds a resumed marker when the session was resumed', async () => {
  const { formatSubagentSessionLine } = await import(`../dist/view/format.js?t=${unique()}`);
  const resumed = fakeAgent({
    config: { resumable: true },
    status: { kind: 'completed', startedAt: 1000, completedAt: 2000, response: 'done' },
  });
  resumed.resumed = true;
  const line = formatSubagentSessionLine(resumed, 4000);
  assert.match(line, /resumed/);
});

test('completedRun marks the result as not resumed by default', async () => {
  const { Agent } = await import(`../dist/domain/agent.js?t=${unique()}`);
  const { completedRun } = await import(`../dist/domain/agent-result.js?t=${unique()}`);

  const session = { messages: [], subscribe() { return () => {}; }, async prompt() {}, abort() {} };
  const config = { name: 'helper', description: 'd', systemPrompt: 's', source: 'project' };
  const agent = new Agent('id', 'group', config, { agent: 'helper', prompt: 'p' }, () => {});
  agent.attach(session);

  const result = completedRun(agent, 'p', 'done');
  assert.equal(result.resumed, false);
});
