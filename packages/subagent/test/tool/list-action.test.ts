import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentExtension from "../../src/index.js";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { completedRun, errorRun, interruptedRun } from "../../src/domain/agent-finalize.js";

const baseCtx = () => ({ cwd: process.cwd(), hasUI: false, modelRegistry: { getAll: () => [] } } as any);

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("subagent tool action=list with status filter [completed, error] returns terminal-success and terminal-failed sessions but excludes others", async () => {
  let nextRunner: ((agent: any) => any) | null = null;
  const runner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return nextRunner!(agent);
  };
  const fakeRegistry = {
    agents: new Map([
      ["good", { name: "good", description: "", systemPrompt: "", source: "project", resumable: true, tools: [] }],
      ["bad", { name: "bad", description: "", systemPrompt: "", source: "project", resumable: true, tools: [] }],
      ["cut", { name: "cut", description: "", systemPrompt: "", source: "project", resumable: true, tools: [] }],
    ]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  nextRunner = (agent) => completedRun(agent, "ok");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "good", prompt: "good task" }] }, undefined, undefined, baseCtx());
  nextRunner = (agent) => errorRun(agent, "failed");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "bad", prompt: "bad task" }] }, undefined, undefined, baseCtx());
  nextRunner = (agent) => interruptedRun(agent, "cancelled");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "cut", prompt: "cut task" }] }, undefined, undefined, baseCtx());

  const result = await tool.execute("tool-call", { action: "list", status: ["completed", "error"] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.sessions.length, 2);
  const outcomes = result.details.sessions.map((s: any) => s.status.outcome).sort();
  assert.deepEqual(outcomes, ["completed", "error"]);
});

test("subagent tool action=list with empty status filter returns no sessions distinct from no filter", async () => {
  const runner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return completedRun(agent, "ok");
  };
  const fakeRegistry = {
    agents: new Map([["good", { name: "good", description: "", systemPrompt: "", source: "project", resumable: true, tools: [] }]]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "good", prompt: "go" }] }, undefined, undefined, baseCtx());

  const noFilter = await tool.execute("tool-call", { action: "list" }, undefined, undefined, baseCtx());
  assert.equal(noFilter.details.sessions.length, 1);

  const emptyFilter = await tool.execute("tool-call", { action: "list", status: [] }, undefined, undefined, baseCtx());
  assert.equal(emptyFilter.isError, false);
  assert.deepEqual(emptyFilter.details.sessions, []);
});

test("subagent tool action=list with an unknown status value returns the unknown-status error", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-list-unknown-status-"));
  const tool = registerExtension();
  const result = await tool.execute("tool-call", { action: "list", status: ["weird"] }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown status 'weird'/);
  assert.match(result.content[0].text, /queued, running, completed, error, aborted, interrupted, skipped/);
});

test("subagent tool action=list with no filter returns retained sessions tagged kind: retained", async () => {
  const runner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.setEffectiveConfig({
      model: "test/model",
      thinking: "high",
      cwd: "/work/project",
      skills: ["requested-skill"],
      tools: ["read"],
      resumable: true,
    });
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return completedRun(agent, "The final answer from the child.");
  };
  const fakeRegistry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "Keeps context", systemPrompt: "s", source: "project", resumable: true, model: "test/model", tools: ["read"], skills: ["default-skill"] }],
    ]),
    async reload() {},
    summarizeAgent() { return "chatty (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "chatty", prompt: "Remember this work.", skills: ["requested-skill"] }] }, undefined, undefined, baseCtx());

  const result = await tool.execute("tool-call", { action: "list" }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.view, "inventory");
  assert.equal(result.details.sessions.length, 1);
  const retained = result.details.sessions[0];
  assert.equal(retained.config.name, "chatty");
  assert.equal(retained.status.kind, "done");
  assert.equal(retained.status.outcome, "completed");
  assert.equal(retained.config.source, "project");
  assert.equal(retained.config.model, "test/model");
  assert.deepEqual(retained.config.tools, ["read"]);
  assert.deepEqual(retained.config.skills, ["requested-skill"]);
  assert.equal(retained.status.output, "The final answer from the child.");
  assert.equal(retained.dispatch, "foreground");
  assert.equal(retained.retention, "persistent");

  const modelSession = JSON.parse(result.content[0].text).sessions[0];
  assert.equal(modelSession.status.kind, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(modelSession.status, "outcome"), false);
  assert.equal(modelSession.status.output, "The final answer from the child.");
  assert.deepEqual(modelSession.config.skills, ["requested-skill"]);
  assert.deepEqual(modelSession.effectiveConfig, {
    model: "test/model",
    thinking: "high",
    cwd: "/work/project",
    skills: ["requested-skill"],
    tools: ["read"],
    resumable: true,
  });
  assert.deepEqual(modelSession.capabilities, { canResume: true, canRemove: true });
});

test("model-facing inventory reports background sessions as removable without leaking canClear", async () => {
  const runner = async (_ctx: any, agent: any, _attempt: any) => {
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return completedRun(agent, "done");
  };
  const fakeRegistry = {
    agents: new Map([
      ["oneshot", { name: "oneshot", description: "", systemPrompt: "", source: "project", resumable: false, tools: [] }],
    ]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const handle = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "oneshot", prompt: "go" }],
    undefined,
    { background: true },
  );
  await handle.resultsPromise;
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const result = await tool.execute("tool-call", { action: "list" }, undefined, undefined, baseCtx());

  assert.equal(result.details.sessions[0].capabilities.canRemove, true);
  assert.equal(result.details.sessions[0].capabilities.canClear, true, "deprecated alias matches the safe removal capability");
  const modelSession = JSON.parse(result.content[0].text).sessions[0];
  assert.deepEqual(modelSession.capabilities, { canResume: false, canRemove: true });
  assert.equal(Object.prototype.hasOwnProperty.call(modelSession.capabilities, "canClear"), false);
});

test("model-facing inventory does not advertise active sessions as safely removable", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    await gate;
    return completedRun(agent, "done");
  };
  const fakeRegistry = {
    agents: new Map([
      ["worker", { name: "worker", description: "Works", systemPrompt: "", source: "project", resumable: true, tools: [] }],
    ]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const handle = manager.startRun(
    baseCtx(),
    undefined,
    [{ kind: "spawn", agent: "worker", prompt: "go" }],
    undefined,
    { background: false },
  );
  await new Promise(resolve => setImmediate(resolve));
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  const result = await tool.execute("tool-call", { action: "list" }, undefined, undefined, baseCtx());
  const detailsSession = result.details.sessions[0];
  assert.equal(detailsSession.status.kind, "running");
  assert.equal(detailsSession.capabilities.canRemove, false);
  assert.equal(detailsSession.capabilities.canClear, false);
  assert.deepEqual(JSON.parse(result.content[0].text).sessions[0].capabilities, {
    canResume: false,
    canRemove: false,
  });

  release();
  await handle.resultsPromise;
});
