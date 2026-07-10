import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/domain/agent-registry.js";

test("registry honors discovery options and default resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-config-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "helper.md"), `---\nname: helper\ndescription: Helps\n---\nHelp prompt`);

  const disabled = new AgentRegistry();
  await disabled.reload(root, { discovery: { includeProjectAgents: false } });
  assert.equal(disabled.agents.has("helper"), false);

  const enabled = new AgentRegistry();
  await enabled.reload(root, { defaultResumable: true });
  assert.equal(enabled.agents.get("helper")?.resumable, true);
});

test("registry loads markdown files from ctx cwd project dir and keys by frontmatter name", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(
    join(projectAgents, "filename.md"),
    `---\nname: runtime-name\ndescription: Runtime description\nresumable: true\n---\nSystem prompt`,
  );

  const registry = new AgentRegistry();
  await registry.reload(root);

  assert.equal(registry.agents.has("filename"), false);
  assert.equal(registry.agents.get("runtime-name")?.systemPrompt, "System prompt");
  assert.equal(registry.agents.get("runtime-name")?.resumable, true);
});
