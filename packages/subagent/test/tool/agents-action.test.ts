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

test("tool agents action projects each definition with tools, default skills, and source path while hiding systemPrompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-agents-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(
    join(projectAgents, "helper.md"),
    `---\nname: helper\ndescription: Helps\nresumable: true\nmodel: test/model\ntools: read, bash\nskills: foo, bar\n---\nHelp prompt`,
  );

  const tool = registerExtension();
  const result = await tool.execute("tool-call", { action: "agents" }, undefined, undefined, { cwd: root });

  assert.equal(result.isError, false);
  assert.equal(result.details.view, "agents");
  const helper = result.details.agents.find((a: any) => a.name === "helper");
  assert.ok(helper);
  assert.equal(helper.resumable, true, "renderer details keep the internal config field");
  assert.equal(helper.sourcePath, join(projectAgents, "helper.md"));
  assert.deepEqual(helper.tools, ["read", "bash"]);
  assert.deepEqual(helper.skills, ["foo", "bar"]);
  assert.equal(Object.prototype.hasOwnProperty.call(helper, "systemPrompt"), false);

  const modelHelper = JSON.parse(result.content[0].text).agents.find((a: any) => a.name === "helper");
  assert.equal(modelHelper.defaultResumable, true);
  assert.equal(Object.prototype.hasOwnProperty.call(modelHelper, "resumable"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(modelHelper, "systemPrompt"), false);
});
