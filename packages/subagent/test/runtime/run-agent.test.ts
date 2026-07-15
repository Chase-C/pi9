import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

import { RunAttempt } from "../../src/runtime/run-agent.js";
import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import { toResult } from "../../src/domain/agent-result.js";

const noop: AgentUpdateListener = () => {};

const SAVED_TIMING = process.env.PI_SUBAGENT_DEBUG_TIMING;
const SAVED_TIMING_FILE = process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;
afterEach(() => {
  if (SAVED_TIMING === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING;
  else process.env.PI_SUBAGENT_DEBUG_TIMING = SAVED_TIMING;
  if (SAVED_TIMING_FILE === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;
  else process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = SAVED_TIMING_FILE;
});

const baseConfig = {
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
  resumable: false,
};

const baseCtx = (cwd: string = process.cwd()) => ({ cwd, modelRegistry: { getAll: () => [] } } as any);

const makeBaseDeps = (overrides: any = {}) => ({
  ResourceLoader: class { async reload() {} },
  getAgentDir: () => "/tmp/pi-agent",
  createAgentSession: async () => ({ session: { messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} } }),
  sessionManager: (cwd: string) => ({ cwd }),
  settingsManager: (cwd: string, agentDir: string) => ({ cwd, agentDir }),
  readSkillFile: () => "---\nname: test\ndescription: Test skill\n---\n\nFull skill instructions.",
  loadExtensionPaths: async () => [],
  ...overrides,
});

test("run-agent skips before prompting when signal aborts during setup", async () => {
  const controller = new AbortController();
  let createCalled = false;
  let promptCalled = false;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "should not prompt" }] }],
    subscribe: () => () => {},
    prompt: async () => { promptCalled = true; },
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    ResourceLoader: class { async reload() { controller.abort(); } },
    createAgentSession: async () => { createCalled = true; return { session }; },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), controller.signal, dependencies));

  assert.equal(result.status, "skipped");
  assert.match(result.error ?? "", /Agent skipped/);
  assert.equal(createCalled, false);
  assert.equal(promptCalled, false);
  if (agent.status.kind !== "done") throw new Error("expected done");
  assert.equal(agent.status.outcome, "skipped");
});

test("run-agent resolves relative task cwd against context cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-cwd-"));
  let loaderOptions: any;
  let createOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    ResourceLoader: class { constructor(options: any) { loaderOptions = options; } async reload() {} },
    createAgentSession: async (options: any) => { createOptions = options; return { session }; },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", cwd: "nested/project" }, noop);

  await RunAttempt(baseCtx(root), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  const expectedCwd = join(root, "nested/project");
  assert.equal(loaderOptions.cwd, expectedCwd);
  assert.equal(createOptions.cwd, expectedCwd);
  assert.equal(createOptions.sessionManager.cwd, expectedCwd);
  assert.equal(createOptions.settingsManager.cwd, expectedCwd);
});

test("run-agent uses frontmatter thinking when task does not override it", async () => {
  let createOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => { createOptions = options; return { session }; },
  });
  const agent = new Agent("id", { ...baseConfig, name: "thinker", thinking: "high" }, { kind: "spawn", agent: "thinker", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(createOptions.thinkingLevel, "high");
});

test("run-agent forwards configured tools allowlist to createAgentSession", async () => {
  let createOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => { createOptions = options; return { session }; },
  });
  const agent = new Agent(
    "id",
    { ...baseConfig, name: "limited", tools: ["read", "grep"], model: "model-a" },
    { kind: "spawn", agent: "limited", prompt: "work" }, noop,
  );

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.output, "final");
  assert.deepEqual(createOptions.tools, ["read", "grep"]);
});

test("run-agent records the complete resolved effective config in snapshots and results", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-effective-config-"));
  const selectedModel = { provider: "test", id: "child-model" } as any;
  const session = {
    model: selectedModel,
    thinkingLevel: "high",
    getActiveToolNames: () => ["read", "subagent"],
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({ createAgentSession: async () => ({ session }) });
  const agent = new Agent(
    "id",
    { ...baseConfig, tools: ["read"], skills: ["default-skill"] },
    {
      kind: "spawn",
      agent: "helper",
      prompt: "work",
      model: "test/child-model",
      thinking: "high",
      cwd: "nested",
      skills: [],
      resumable: true,
    },
    noop,
  );
  const ctx = { cwd: root, modelRegistry: { getAll: () => [selectedModel] } } as any;

  const result = toResult(await RunAttempt(ctx, agent, agent.requireCurrentAttempt(), undefined, dependencies));

  const effectiveConfig = {
    model: "test/child-model",
    thinking: "high",
    cwd: join(root, "nested"),
    skills: [],
    tools: ["read", "subagent"],
    resumable: true,
  };
  assert.deepEqual(result.effectiveConfig, effectiveConfig);
  assert.deepEqual(agent.snapshot().effectiveConfig, effectiveConfig);
});

test("run-agent marks running parent cancellation as interrupted", async () => {
  const controller = new AbortController();
  let abortCalls = 0;
  let resolvePrompt: (() => void) | undefined;
  const session = {
    messages: [] as any[],
    subscribe: () => () => {},
    prompt: async () => { await new Promise<void>(resolve => { resolvePrompt = resolve; }); },
    abort: () => {
      abortCalls += 1;
      session.messages = [{ role: "assistant", stopReason: "aborted", errorMessage: "user cancelled", content: [{ type: "text", text: "partial" }] }];
      resolvePrompt?.();
    },
  };
  const dependencies = makeBaseDeps({ createAgentSession: async () => ({ session }) });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const pending = RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), controller.signal, dependencies);
  await new Promise(resolve => setTimeout(resolve, 20));
  const midKind: string = agent.status.kind;
  assert.equal(midKind, "running");

  controller.abort();

  const result = toResult(await pending);
  assert.equal(result.status, "interrupted");
  assert.match(result.error ?? "", /user cancelled/);
  assert.equal(abortCalls, 1);
  const final = agent.status;
  if (final.kind !== "done") throw new Error("expected done");
  assert.equal(final.outcome, "interrupted");
});

test("run-agent treats final assistant error stop reason as failed child run", async () => {
  const session = {
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "model overloaded", content: [{ type: "text", text: "partial output" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({ createAgentSession: async () => ({ session }) });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /model overloaded/);
  if (agent.status.kind !== "done") throw new Error("expected done");
  assert.equal(agent.status.outcome, "error");
  assert.equal(agent.status.error, "model overloaded");
});

test("run-agent injects requested skill bodies into the system prompt and disables loader skill scanning", async () => {
  let loaderOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const skills = [
    { name: "tdd", description: "Test-driven development", filePath: "/skills/tdd/SKILL.md", baseDir: "/skills/tdd", sourceInfo: { path: "/skills/tdd/SKILL.md", source: "local", scope: "project", origin: "top-level" }, disableModelInvocation: false },
    { name: "review", description: "Review pending changes", filePath: "/skills/review/SKILL.md", baseDir: "/skills/review", sourceInfo: { path: "/skills/review/SKILL.md", source: "local", scope: "user", origin: "top-level" }, disableModelInvocation: true },
  ];
  const dependencies = makeBaseDeps({
    ResourceLoader: class { constructor(options: any) { loaderOptions = options; } async reload() {} },
    createAgentSession: async () => ({ session }),
    loadSkills: () => ({ skills, diagnostics: [] }),
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT" }, { kind: "spawn", agent: "helper", prompt: "work", skills: ["tdd", "review"] }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "completed");
  assert.equal(loaderOptions.noSkills, true);
  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /^BASE PROMPT/);
  assert.match(prompt, /<skill name="tdd" location="\/skills\/tdd\/SKILL.md">/);
  assert.match(prompt, /References are relative to \/skills\/tdd\./);
  assert.match(prompt, /Full skill instructions\./);
  assert.doesNotMatch(prompt, /description: Test skill/);
  // disable-model-invocation skills are not filtered when explicitly named.
  assert.match(prompt, /<skill name="review" location="\/skills\/review\/SKILL.md">/);
});

test("run-agent reports an unreadable requested skill as a failed run without starting a session", async () => {
  let createCalled = false;
  const skill = {
    name: "broken",
    description: "Broken skill",
    filePath: "/skills/broken/SKILL.md",
    baseDir: "/skills/broken",
    sourceInfo: { path: "/skills/broken/SKILL.md", source: "local", scope: "project", origin: "top-level" },
    disableModelInvocation: false,
  };
  const dependencies = makeBaseDeps({
    createAgentSession: async () => { createCalled = true; return { session: { subscribe: () => () => {}, prompt: async () => {}, abort: () => {}, messages: [] } }; },
    loadSkills: () => ({ skills: [skill], diagnostics: [] }),
    readSkillFile: () => { throw new Error("permission denied"); },
  });
  const agent = new Agent("id", { ...baseConfig, skills: ["broken"] }, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /Could not load requested skill: permission denied/);
  assert.equal(createCalled, false);
});

test("run-agent reports an unknown skill from per-task or frontmatter sources as a failed run without starting a session", async () => {
  for (const source of ["per-task", "frontmatter"] as const) {
    let createCalled = false;
    const dependencies = makeBaseDeps({
      createAgentSession: async () => { createCalled = true; return { session: { subscribe: () => () => {}, prompt: async () => {}, abort: () => {}, messages: [] } }; },
      loadSkills: () => ({ skills: [], diagnostics: [] }),
    });
    const agent = source === "per-task"
      ? new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", skills: ["missing"] }, noop)
      : new Agent("id", { ...baseConfig, skills: ["missing"] }, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

    const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

    assert.equal(result.status, "error", `${source}: expected error`);
    assert.match(result.error ?? "", /missing/);
    assert.equal(createCalled, false);
    if (agent.status.kind !== "done") throw new Error("expected done");
    assert.equal(agent.status.outcome, "error");
  }
});

test("run-agent uses agent-frontmatter default skills when the task does not provide skills", async () => {
  let loaderOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const skill = {
    name: "foo",
    description: "Default foo skill",
    filePath: "/skills/foo/SKILL.md",
    baseDir: "/skills/foo",
    sourceInfo: { path: "/skills/foo/SKILL.md", source: "local", scope: "project", origin: "top-level" },
    disableModelInvocation: false,
  };
  const dependencies = makeBaseDeps({
    ResourceLoader: class { constructor(options: any) { loaderOptions = options; } async reload() {} },
    createAgentSession: async () => ({ session }),
    loadSkills: () => ({ skills: [skill], diagnostics: [] }),
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT", skills: ["foo"] }, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "completed");
  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /^BASE PROMPT/);
  assert.match(prompt, /<skill name="foo" location="\/skills\/foo\/SKILL.md">/);
  assert.match(prompt, /Full skill instructions\./);
  assert.deepEqual(agent.snapshot().config.skills, ["foo"]);
});

test("run-agent per-task skills fully replace agent-frontmatter default skills", async () => {
  let loaderOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const skills = [
    { name: "foo", description: "foo skill", filePath: "/skills/foo/SKILL.md", baseDir: "/skills/foo", sourceInfo: { path: "/skills/foo/SKILL.md", source: "local", scope: "project", origin: "top-level" }, disableModelInvocation: false },
    { name: "bar", description: "bar skill", filePath: "/skills/bar/SKILL.md", baseDir: "/skills/bar", sourceInfo: { path: "/skills/bar/SKILL.md", source: "local", scope: "project", origin: "top-level" }, disableModelInvocation: false },
    { name: "baz", description: "baz skill", filePath: "/skills/baz/SKILL.md", baseDir: "/skills/baz", sourceInfo: { path: "/skills/baz/SKILL.md", source: "local", scope: "project", origin: "top-level" }, disableModelInvocation: false },
  ];
  const dependencies = makeBaseDeps({
    ResourceLoader: class { constructor(options: any) { loaderOptions = options; } async reload() {} },
    createAgentSession: async () => ({ session }),
    loadSkills: () => ({ skills, diagnostics: [] }),
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE", skills: ["foo", "baz"] }, { kind: "spawn", agent: "helper", prompt: "work", skills: ["bar"] }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /<skill name="bar"/);
  assert.deepEqual(agent.snapshot().effectiveConfig?.skills, ["bar"]);
  assert.deepEqual(agent.snapshot().config.skills, ["bar"]);
  assert.doesNotMatch(prompt, /<skill name="foo"/);
  assert.doesNotMatch(prompt, /<skill name="baz"/);
});

test("run-agent explicit empty per-task skills opts out of agent-frontmatter defaults", async () => {
  let loaderOptions: any;
  let loadSkillsCalls = 0;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    ResourceLoader: class { constructor(options: any) { loaderOptions = options; } async reload() {} },
    createAgentSession: async () => ({ session }),
    loadSkills: () => { loadSkillsCalls += 1; return { skills: [], diagnostics: [] }; },
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT", skills: ["foo"] }, { kind: "spawn", agent: "helper", prompt: "work", skills: [] }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(loaderOptions.systemPromptOverride(), "BASE PROMPT");
  assert.equal(loadSkillsCalls, 0, "should not load skills when the task explicitly opted out");
  assert.deepEqual(agent.snapshot().config.skills, []);
});

test("emits coarse async spans for an attempt but no per-step sync narration when timing is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-timing-"));
  const logFile = join(root, "timing.log");
  process.env.PI_SUBAGENT_DEBUG_TIMING = "1";
  process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = logFile;

  const dependencies = makeBaseDeps();
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  const log = await readFile(logFile, "utf8");
  // The retained spans wrap the genuinely variable-cost async work of an attempt.
  assert.match(log, /event=runAgent\.resourceLoader\.reload\b/);
  assert.match(log, /event=runAgent\.createAgentSession\b/);
  assert.match(log, /event=runAgent\.session\.prompt\b/);
  // The per-step sync narration and result-summary marks are dropped.
  for (const dropped of [
    "runAgent.start",
    "runAgent.resolveCwd",
    "runAgent.selectModel",
    "runAgent.newResourceLoader",
  ]) {
    assert.doesNotMatch(log, new RegExp(`event=${dropped.replace(/\./g, "\\.")}\\b`), `unexpected event ${dropped}`);
  }
  await rm(logFile, { force: true });
});

test("inherited paths load through the native extension loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-native-loader-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const entry = join(root, "pi-ai-extension.ts");
  await writeFile(entry, `
    import { streamSimpleOpenAICodexResponses } from "@earendil-works/pi-ai";
    export default () => {
      if (typeof streamSimpleOpenAICodexResponses !== "function") {
        throw new Error("Expected exported helper was unavailable");
      }
    };
  `);

  let capturedLoader: any;
  const dependencies = makeBaseDeps({
    ResourceLoader: DefaultResourceLoader,
    getAgentDir: () => agentDir,
    loadExtensionPaths: async () => [entry],
    createAgentSession: async (options: any) => {
      capturedLoader = options.resourceLoader;
      return {
        session: {
          messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
          subscribe: () => () => {},
          prompt: async () => {},
          abort: () => {},
        },
      };
    },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(root), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  const loaded = capturedLoader.getExtensions();
  assert.equal(loaded.errors.length, 0, `loader reported errors: ${JSON.stringify(loaded.errors)}`);
  assert.ok(loaded.extensions.some((ext: any) => ext.resolvedPath === entry || ext.path === entry));
});

test("run-agent discovers inherited paths with the resolved cwd and agent dir for every child", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-path-args-"));
  const calls: Array<{ cwd: string; agentDir: string }> = [];
  const dependencies = makeBaseDeps({
    getAgentDir: () => "/tmp/agent-dir",
    loadExtensionPaths: async (cwd: string, agentDir: string) => {
      calls.push({ cwd, agentDir });
      return [];
    },
  });

  for (let i = 0; i < 2; i++) {
    const agent = new Agent(`id-${i}`, baseConfig, { kind: "spawn", agent: "helper", prompt: "work", cwd: "child" }, noop);
    await RunAttempt(baseCtx(root), agent, agent.requireCurrentAttempt(), undefined, dependencies);
  }

  assert.deepEqual(calls, [
    { cwd: join(root, "child"), agentDir: "/tmp/agent-dir" },
    { cwd: join(root, "child"), agentDir: "/tmp/agent-dir" },
  ]);
});

test("run-agent passes inherited paths to a noExtensions resource loader", async () => {
  let loaderOptions: any;
  const inheritedPaths = ["/tmp/extensions/one.ts", "/tmp/extensions/two.ts"];
  const dependencies = makeBaseDeps({
    ResourceLoader: class { constructor(options: any) { loaderOptions = options; } async reload() {} },
    loadExtensionPaths: async () => inheritedPaths,
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(loaderOptions.noExtensions, true);
  assert.deepEqual(loaderOptions.additionalExtensionPaths, inheritedPaths);
  assert.equal(loaderOptions.extensionFactories, undefined);
});

test("run-agent passes the manager-supplied child tool through createAgentSession.customTools", async () => {
  let createOptions: any;
  let childToolArg: any;
  const childTool = { name: "subagent" };
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => {
      createOptions = options;
      return { session: { messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} } };
    },
    childToolFor: (agent: any) => { childToolArg = agent; return childTool; },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.deepEqual(createOptions.customTools, [childTool]);
  assert.equal(childToolArg, agent);
});

test("run-agent passes no custom child tools when childToolFor is absent", async () => {
  let createOptions: any;
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => {
      createOptions = options;
      return { session: { messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} } };
    },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.deepEqual(createOptions.customTools, []);
});

test("run-agent leaves the system prompt unchanged when no skills are requested", async () => {
  let loaderOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    ResourceLoader: class { constructor(options: any) { loaderOptions = options; } async reload() {} },
    createAgentSession: async () => ({ session }),
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT" }, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(loaderOptions.systemPromptOverride(), "BASE PROMPT");
});
