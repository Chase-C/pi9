import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentExtension from "../../src/index.js";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { completedRun, errorRun, interruptedRun } from "../../src/domain/agent-result.js";

const baseCtx = () => ({ cwd: process.cwd(), hasUI: false, modelRegistry: { getAll: () => [] } } as any);

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("tool list action with legacy type=agents returns a migration error pointing at action=agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-list-type-agents-"));
  const tool = registerExtension();
  const result = await tool.execute("tool-call", { action: "list", type: "agents" }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /'type' parameter has been removed/);
  assert.match(result.content[0].text, /action: 'agents'/);
  assert.match(result.content[0].text, /Skills listing is no longer exposed/);
});

test("tool list action with legacy type=sessions returns the same migration error", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-list-type-sessions-"));
  const tool = registerExtension();
  const result = await tool.execute("tool-call", { action: "list", type: "sessions" }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /'type' parameter has been removed/);
  assert.match(result.content[0].text, /action: 'list'/);
});

test("tool list action with legacy type=skills returns the migration error noting skills are no longer exposed", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-list-type-skills-"));
  const tool = registerExtension();
  const result = await tool.execute("tool-call", { action: "list", type: "skills" }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Skills listing is no longer exposed/);
});

test("subagent tool action=list with status filter [completed, error] returns terminal-success and terminal-failed sessions but excludes others", async () => {
  let nextRunner: ((agent: any, prompt: string) => any) | null = null;
  const runner = async (_ctx: any, agent: any) => { const prompt = agent.current?.prompt ?? "";
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return nextRunner!(agent, prompt);
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

  nextRunner = (agent, prompt) => completedRun(agent, "ok");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "good", prompt: "good task" }] }, undefined, undefined, baseCtx());
  nextRunner = (agent, prompt) => errorRun(agent, "failed");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "bad", prompt: "bad task" }] }, undefined, undefined, baseCtx());
  nextRunner = (agent, prompt) => interruptedRun(agent, "cancelled");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "cut", prompt: "cut task" }] }, undefined, undefined, baseCtx());

  const result = await tool.execute("tool-call", { action: "list", status: ["completed", "error"] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.sessions.length, 2);
  const outcomes = result.details.sessions.map((s: any) => s.status.outcome).sort();
  assert.deepEqual(outcomes, ["completed", "error"]);
});

test("subagent tool action=list with empty status filter returns no sessions distinct from no filter", async () => {
  const runner = async (_ctx: any, agent: any) => { const prompt = agent.current?.prompt ?? "";
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

test("subagent tool action=list with status filter [completed] returns only completed sessions", async () => {
  let nextRunner: ((agent: any, prompt: string) => any) | null = null;
  const runner = async (_ctx: any, agent: any) => { const prompt = agent.current?.prompt ?? "";
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return nextRunner?.(agent, prompt) ?? completedRun(agent, "ok");
  };
  const fakeRegistry = {
    agents: new Map([
      ["good", { name: "good", description: "", systemPrompt: "", source: "project", resumable: true, tools: [] }],
      ["bad", { name: "bad", description: "", systemPrompt: "", source: "project", resumable: true, tools: [] }],
    ]),
    async reload() {},
    summarizeAgent() { return ""; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  nextRunner = (agent, prompt) => completedRun(agent, "ok");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "good", prompt: "good task" }] }, undefined, undefined, baseCtx());

  nextRunner = (agent, prompt) => errorRun(agent, "failed");
  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "bad", prompt: "bad task" }] }, undefined, undefined, baseCtx());

  const result = await tool.execute("tool-call", { action: "list", status: ["completed"] }, undefined, undefined, baseCtx());

  assert.equal(result.isError, false);
  assert.equal(result.details.sessions.length, 1);
  assert.equal(result.details.sessions[0].config.name, "good");
  assert.equal(result.details.sessions[0].status.outcome, "completed");
});

test("subagent tool action=list with no filter returns retained sessions tagged kind: retained", async () => {
  const runner = async (_ctx: any, agent: any) => { const prompt = agent.current?.prompt ?? "";
    agent.attach({ messages: [], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} });
    return completedRun(agent, "The final answer from the child.");
  };
  const fakeRegistry = {
    agents: new Map([
      ["chatty", { name: "chatty", description: "Keeps context", systemPrompt: "s", source: "project", resumable: true, model: "test/model", tools: ["read"] }],
    ]),
    async reload() {},
    summarizeAgent() { return "chatty (project)"; },
  };
  const manager = new AgentManager(fakeRegistry as any, 1, runner);
  const tool = registerExtension({ agentRegistry: fakeRegistry, agentManager: manager });

  await tool.execute("tool-call", { action: "run", tasks: [{ agent: "chatty", prompt: "Remember this work." }] }, undefined, undefined, baseCtx());

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
  assert.equal(retained.status.snippet, "The final answer from the child.");
  assert.equal(retained.kind, "retained");
});
