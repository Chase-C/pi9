import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import subagentExtension from "../../src/index.js";

function registerExtension(dependencies: any = {}) {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any, dependencies);
  return registeredTool;
}

test("subagent extension still registers the tool when custom resume renderer registration fails", () => {
  let registeredTool: any;
  assert.doesNotThrow(() => subagentExtension({
    registerCommand() {},
    registerMessageRenderer() { throw new Error("renderer unsupported"); },
    registerTool: (tool: any) => { registeredTool = tool; },
  } as any));
  assert.equal(registeredTool.name, "subagent");
});

test("subagent tool registers prompt metadata for the default system prompt", () => {
  const tool = registerExtension();

  assert.equal(tool.promptSnippet, "Delegate focused work to specialized subagents in isolated context windows");
  assert.deepEqual(tool.promptGuidelines, [
    "Use subagent for work that benefits from independent context, such as codebase reconnaissance, long-running investigation, review, or parallel research; prefer doing the work yourself for small direct tasks.",
    "Before using subagent without a named agent from the user, call subagent with action: \"agents\" and choose an agent whose prompt, tools, or skills fit the task.",
    "When calling subagent, make each child prompt self-contained with the objective, relevant files or directories, constraints, and expected output format.",
  ]);
});

test("tool execution requires action", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-action-"));
  const tool = registerExtension();

  const result = await tool.execute("tool-call", { tasks: [] }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Provide an action/);
});

test("tool execution validates task count and reports available agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-validation-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "helper.md"), `---\nname: helper\ndescription: Helps\n---\nHelp prompt`);

  const tool = registerExtension();

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: Array.from({ length: 9 }, (_, i) => ({ agent: "helper", prompt: `task ${i}` })),
  }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Too many tasks \(9\)\. Max is 8/);
  assert.match(result.content[0].text, /helper \(project\)/);
});

test("subagent action=resume is no longer recognized", async () => {
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: { sessions: [], listSessions() { return this.sessions; } },
  });

  const result = await tool.execute("tool-call", {
    action: "resume",
    sessionId: "whatever",
    prompt: "follow up",
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown action/);
  assert.match(result.content[0].text, /run/);
});

