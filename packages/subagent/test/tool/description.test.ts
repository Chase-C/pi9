import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";

function registerTool() {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any);
  return registeredTool;
}

test("subagent tool description mentions the optional label per-task field", () => {
  assert.match(registerTool().description, /label/);
});

test("subagent tool description mentions the per-task skills field and rejects unknown skills", () => {
  const description = registerTool().description;
  assert.match(description, /skills/);
  assert.match(description, /unknown skill/i);
  assert.doesNotMatch(description, /type="skills"/);
});

test("subagent tool description mentions agent-frontmatter default skills and replace semantics", () => {
  const description = registerTool().description;
  assert.match(description, /default skills/i);
  assert.match(description, /replace/i);
});

test("subagent tool description mentions the per-task resumable override is one-way", () => {
  const description = registerTool().description;
  assert.match(description, /resumable/);
  assert.match(description, /one-way at completion/);
});

test("subagent tool description documents the unified run surface and mutual exclusion", () => {
  const description = registerTool().description;
  assert.match(description, /action="run"/);
  assert.doesNotMatch(description, /action="start"/);
  assert.doesNotMatch(description, /action="resume"/);
  assert.match(description, /sessionId/);
  assert.match(description, /agent/);
  assert.match(description, /mutually exclusive|reject/i);
});

test("subagent tool description documents action=agents and action=list (sessions only) without skills listing", () => {
  const description = registerTool().description;
  assert.match(description, /action="agents"/);
  assert.match(description, /action="list"/);
  assert.match(description, /status: an array/i);
  assert.match(description, /kind tag/i);
  assert.doesNotMatch(description, /type="skills"/);
  assert.doesNotMatch(description, /type="sessions"/);
  assert.doesNotMatch(description, /type="agents"/);
});

test("subagent tool description documents action=remove and drops references to action=clear", () => {
  const description = registerTool().description;
  assert.match(description, /action="remove"/);
  assert.match(description, /sessionIds/);
  assert.match(description, /scope/);
  assert.doesNotMatch(description, /action="clear"/);
});

test("subagent tool description documents batch-level background flag and references results/remove", () => {
  const description = registerTool().description;
  assert.match(description, /background/);
  assert.match(description, /batch-level/);
  assert.match(description, /subagent results/);
  assert.match(description, /subagent remove/);
});

test("subagent tool description documents action=results, never-blocks contract, and the remove option", () => {
  const description = registerTool().description;
  assert.match(description, /action="results"/);
  assert.match(description, /sessionIds/);
  assert.match(description, /never blocks/i);
  assert.match(description, /remove: true/);
});
