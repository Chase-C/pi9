import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunAttempt } from "../../src/runtime/run-agent.js";
import { Agent } from "../../src/domain/agent.js";

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
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" });

  const result = await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), controller.signal, dependencies);

  assert.equal(result.status, "skipped");
  assert.match(result.error ?? "", /Agent skipped/);
  assert.equal(createCalled, false);
  assert.equal(promptCalled, false);
  if (agent.status.kind !== "done") throw new Error("expected done");
  assert.equal(agent.status.result.status, "skipped");
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
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", cwd: "nested/project" });

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
  const agent = new Agent("id", { ...baseConfig, name: "thinker", thinking: "high" }, { kind: "spawn", agent: "thinker", prompt: "work" });

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
    { kind: "spawn", agent: "limited", prompt: "work" },
  );

  const result = await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(result.output, "final");
  assert.deepEqual(createOptions.tools, ["read", "grep"]);
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
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" });

  const pending = RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), controller.signal, dependencies);
  await new Promise(resolve => setTimeout(resolve, 20));
  const midKind: string = agent.status.kind;
  assert.equal(midKind, "running");

  controller.abort();

  const result = await pending;
  assert.equal(result.status, "interrupted");
  assert.match(result.error ?? "", /user cancelled/);
  assert.equal(abortCalls, 1);
  const final = agent.status;
  if (final.kind !== "done") throw new Error("expected done");
  assert.equal(final.result.status, "interrupted");
});

test("run-agent treats final assistant error stop reason as failed child run", async () => {
  const session = {
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "model overloaded", content: [{ type: "text", text: "partial output" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({ createAgentSession: async () => ({ session }) });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" });

  const result = await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /model overloaded/);
  if (agent.status.kind !== "done") throw new Error("expected done");
  assert.equal(agent.status.result.status, "error");
  assert.equal(agent.status.result.error, "model overloaded");
});

test("run-agent injects requested skills into the system prompt and disables loader skill scanning", async () => {
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
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT" }, { kind: "spawn", agent: "helper", prompt: "work", skills: ["tdd", "review"] });

  const result = await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(result.status, "completed");
  assert.equal(loaderOptions.noSkills, true);
  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /^BASE PROMPT/);
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /<name>tdd<\/name>/);
  assert.match(prompt, /<description>Test-driven development<\/description>/);
  // disable-model-invocation skills are not filtered when explicitly named.
  assert.match(prompt, /<name>review<\/name>/);
});

test("run-agent reports an unknown skill from per-task or frontmatter sources as a failed run without starting a session", async () => {
  for (const source of ["per-task", "frontmatter"] as const) {
    let createCalled = false;
    const dependencies = makeBaseDeps({
      createAgentSession: async () => { createCalled = true; return { session: { subscribe: () => () => {}, prompt: async () => {}, abort: () => {}, messages: [] } }; },
      loadSkills: () => ({ skills: [], diagnostics: [] }),
    });
    const agent = source === "per-task"
      ? new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", skills: ["missing"] })
      : new Agent("id", { ...baseConfig, skills: ["missing"] }, { kind: "spawn", agent: "helper", prompt: "work" });

    const result = await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

    assert.equal(result.status, "error", `${source}: expected error`);
    assert.match(result.error ?? "", /missing/);
    assert.equal(createCalled, false);
    if (agent.status.kind !== "done") throw new Error("expected done");
    assert.equal(agent.status.result.status, "error");
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
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT", skills: ["foo"] }, { kind: "spawn", agent: "helper", prompt: "work" });

  const result = await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(result.status, "completed");
  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /^BASE PROMPT/);
  assert.match(prompt, /<name>foo<\/name>/);
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
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE", skills: ["foo", "baz"] }, { kind: "spawn", agent: "helper", prompt: "work", skills: ["bar"] });

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  const prompt = loaderOptions.systemPromptOverride();
  assert.match(prompt, /<name>bar<\/name>/);
  assert.doesNotMatch(prompt, /<name>foo<\/name>/);
  assert.doesNotMatch(prompt, /<name>baz<\/name>/);
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
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT", skills: ["foo"] }, { kind: "spawn", agent: "helper", prompt: "work", skills: [] });

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(loaderOptions.systemPromptOverride(), "BASE PROMPT");
  assert.equal(loadSkillsCalls, 0, "should not load skills when the task explicitly opted out");
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
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT" }, { kind: "spawn", agent: "helper", prompt: "work" });

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(loaderOptions.systemPromptOverride(), "BASE PROMPT");
});
