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

test("subagent tool registers concise prompt metadata", () => {
  const tool = registerExtension();

  assert.equal(tool.description, [
    "Delegate work to context-isolated subagent sessions. Subagents share the working filesystem.",
    "Actions:",
    "  `agents` lists available agent definitions",
    "  `list` returns lightweight session status, optionally filtered by `status`",
    "  `run` spawns (`agent`) or resumes (`sessionId`) tasks; multiple tasks run concurrently",
    "  `results` returns full output/errors for sessionIds without waiting; `remove: true` also deletes terminal sessions",
    "  `remove` aborts active sessions and discards queued/terminal sessions",
  ].join("\n"));
  assert.equal(tool.promptSnippet, "Delegate bounded work to context-isolated subagents");
  assert.deepEqual(tool.promptGuidelines, [
    "Use subagent for bounded work that benefits from specialization, parallelism, or a fresh context.",
    "Skip subagent when delegation overhead exceeds doing the work directly, or when its output cannot be verified or consumed without repeating the work.",
    "Call subagent action=agents before choosing an agent unless the user named one explicitly or definitions were already listed.",
    "Subagents spawn with no knowledge of the parent conversation — the prompt is everything they receive, so include all information the task requires.",
    "Use subagent background=true only when the parent has independent work to continue; otherwise prefer foreground results.",
  ]);
});

test("tool execution requires action", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-action-"));
  const tool = registerExtension();

  const result = await tool.execute("tool-call", { tasks: [] }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Provide an action/);
});

test("tool execution requires a non-empty label for spawn tasks", async () => {
  const tool = registerExtension({
    agentRegistry: { agents: new Map(), async reload() {}, summarizeAgent() { return ""; } },
    agentManager: { sessions: [], listSessions() { return this.sessions; } },
  });

  for (const task of [
    { agent: "helper", prompt: "work" },
    { agent: "helper", prompt: "work", label: "   " },
  ]) {
    const result = await tool.execute(
      "tool-call",
      { action: "run", tasks: [task] },
      undefined,
      undefined,
      { cwd: process.cwd(), hasUI: false },
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /label must be a non-empty string/);
  }
});

test("tool execution validates task count and reports available agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-validation-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "helper.md"), `---\nname: helper\ndescription: Helps\n---\nHelp prompt`);

  const tool = registerExtension();

  const result = await tool.execute("tool-call", {
    action: "run",
    tasks: Array.from({ length: 9 }, (_, i) => ({ agent: "helper", prompt: `task ${i}`, label: `task ${i}` })),
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

