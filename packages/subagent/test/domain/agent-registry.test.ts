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

test("registry skips invalid descriptions and only warns when configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-description-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "invalid.md"), `---\nname: invalid\ndescription: "   "\n---\nPrompt`);

  const silentWarnings: string[] = [];
  const silent = new AgentRegistry();
  await silent.reload(root, { onWarning: warning => silentWarnings.push(warning) });
  assert.equal(silent.agents.has("invalid"), false);
  assert.deepEqual(silentWarnings, []);

  const warnings: string[] = [];
  const warning = new AgentRegistry();
  await warning.reload(root, {
    discovery: { warnOnInvalidAgents: true },
    onWarning: message => warnings.push(message),
  });
  assert.equal(warning.agents.has("invalid"), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Invalid subagent definition.*Expected required field "description"/);
});

test("registry skips invalid thinking levels and warns through the configured channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-thinking-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "invalid.md"), `---\nname: invalid\ndescription: Invalid thinking\nthinking: extreme\n---\nPrompt`);

  const warnings: string[] = [];
  const registry = new AgentRegistry();
  await registry.reload(root, {
    discovery: { warnOnInvalidAgents: true },
    onWarning: message => warnings.push(message),
  });

  assert.equal(registry.agents.has("invalid"), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Invalid subagent definition.*Expected field "thinking" to be one of/);
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
