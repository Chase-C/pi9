import { test } from "vitest";
import assert from "node:assert/strict";

import { BuildAgentConfig } from "../../src/domain/agent-config.js";

function ok<T>(result: T | { error: Error }): T {
  assert.ok(!("error" in (result as any)), `expected ok result, got error: ${(result as any).error?.message}`);
  return result as T;
}

function fail(result: unknown): Error {
  assert.ok(result && typeof result === "object" && "error" in (result as any), "expected error result");
  return (result as { error: Error }).error;
}

test("BuildAgentConfig parses every supported field on the happy path", () => {
  const config = ok(BuildAgentConfig(
    `---\nname: helper\ndescription: d\nmodel: anthropic/claude\nthinking: medium\ntools: read, bash\nskills: foo, bar\n---\n  body text  `,
    "project",
  ));
  assert.equal(config.name, "helper");
  assert.equal(config.description, "d");
  assert.equal(config.model, "anthropic/claude");
  assert.equal(config.thinking, "medium");
  assert.deepEqual(config.tools, ["read", "bash"]);
  assert.deepEqual(config.skills, ["foo", "bar"]);
  assert.equal(config.systemPrompt, "body text");
  assert.equal(config.source, "project");
});

test("BuildAgentConfig leaves optional fields undefined when absent", () => {
  const config = ok(BuildAgentConfig(`---\nname: helper\ndescription: d\n---\nbody`, "project"));
  assert.equal(config.model, undefined);
  assert.equal(config.thinking, undefined);
  assert.equal(config.tools, undefined);
  assert.equal(config.skills, undefined);
});

test("BuildAgentConfig rejects a missing description", () => {
  const err = fail(BuildAgentConfig(`---\nname: helper\n---\nbody`, "project"));
  assert.match(err.message, /Expected required field "description" to be a non-empty string/);
});

test("BuildAgentConfig rejects empty and whitespace-only descriptions", () => {
  for (const description of ['""', '"   "']) {
    const err = fail(BuildAgentConfig(`---\nname: helper\ndescription: ${description}\n---\nbody`, "project"));
    assert.match(err.message, /Expected required field "description" to be a non-empty string/);
  }
});

test("BuildAgentConfig validates but does not normalize a description", () => {
  const config = ok(BuildAgentConfig(`---\nname: helper\ndescription: "  useful  "\n---\nbody`, "project"));
  assert.equal(config.description, "  useful  ");
});

test("BuildAgentConfig returns error when name is missing", () => {
  const err = fail(BuildAgentConfig(`---\ndescription: d\n---\nbody`, "project"));
  assert.match(err.message, /Missing required fields:.*name/);
});

test("BuildAgentConfig accepts every supported thinking level", () => {
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const config = ok(BuildAgentConfig(`---\nname: helper\ndescription: d\nthinking: ${thinking}\n---\n`, "project"));
    assert.equal(config.thinking, thinking);
  }
});

test("BuildAgentConfig rejects unsupported thinking levels", () => {
  const err = fail(BuildAgentConfig(`---\nname: helper\ndescription: d\nthinking: extreme\n---\n`, "project"));
  assert.match(err.message, /Expected field "thinking" to be one of: off, minimal, low, medium, high, xhigh, max/);
});

test("BuildAgentConfig rejects non-string scalar fields with a type error naming the field", () => {
  const cases: Array<[string, string]> = [
    [`---\nname: 5\ndescription: d\n---\n`, "name"],
    [`---\nname: helper\ndescription: d\nmodel: 5\n---\n`, "model"],
    [`---\nname: helper\ndescription: d\nthinking: 5\n---\n`, "thinking"],
  ];
  for (const [content, field] of cases) {
    const err = fail(BuildAgentConfig(content, "project"));
    assert.match(err.message, new RegExp(`Expected field "${field}"`));
  }
});

test("BuildAgentConfig rejects non-string CSV fields with a type error naming the field", () => {
  for (const field of ["tools", "skills"]) {
    const err = fail(BuildAgentConfig(`---\nname: helper\ndescription: d\n${field}: 5\n---\n`, "project"));
    assert.match(err.message, new RegExp(`Expected field "${field}"`));
  }
});

test("BuildAgentConfig rejects obsolete retention frontmatter with migration guidance", () => {
  for (const [field, prefix] of [["resumable", "Legacy"], ["retainConversation", "Obsolete"]]) {
    const err = fail(BuildAgentConfig(`---\nname: helper\ndescription: d\n${field}: true\n---\nbody`, "project"));
    assert.match(err.message, new RegExp(`${prefix} field "${field}" is not supported; remove it`));
    assert.match(err.message, /Conversation retention is managed centrally/);
  }
});

test("BuildAgentConfig CSV parsing treats 'none' and empty values as undefined and trims items", () => {
  const noneSkills = ok(BuildAgentConfig(`---\nname: a\ndescription: d\nskills: none\n---\n`, "project"));
  assert.equal(noneSkills.skills, undefined);

  const blankTools = ok(BuildAgentConfig(`---\nname: a\ndescription: d\ntools:   \n---\n`, "project"));
  assert.equal(blankTools.tools, undefined);

  const padded = ok(BuildAgentConfig(`---\nname: a\ndescription: d\ntools:   read  ,  bash  \n---\n`, "project"));
  assert.deepEqual(padded.tools, ["read", "bash"]);
});
