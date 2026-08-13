import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseSubagentInvocation } from "../src/schema.js";

const id = "airy-acorn";
const valid: Record<string, Record<string, unknown>> = {
  agents: { action: "agents" },
  list: { action: "list" },
  spawn: { action: "spawn", spawns: [{ agent: "helper", prompt: "work", label: "Worker" }] },
  resume: { action: "resume", resumes: [{ subagentId: id, prompt: "continue" }] },
  steer: { action: "steer", messages: [{ subagentId: id, message: "adjust" }] },
  cancel: { action: "cancel", subagentIds: [id] },
  inspect: { action: "inspect", subagentIds: [id] },
  join: { action: "join", subagentIds: [id] },
  remove: { action: "remove", subagentIds: [id] },
};

const text = (value: unknown) => JSON.stringify(value);

describe("parseSubagentInvocation", () => {
  for (const [action, invocation] of Object.entries(valid)) {
    it(`parses a minimal ${action} invocation`, () => {
      assert.equal((parseSubagentInvocation(invocation) as any).action, action);
      assert.doesNotMatch(text(parseSubagentInvocation(invocation)), /error/);
    });

    it(`rejects an extra property for ${action}`, () => {
      assert.match(text(parseSubagentInvocation({ ...invocation, extra: true })), /Property extra is not allowed/);
    });
  }

  it("rejects a missing or unknown action", () => {
    assert.match(text(parseSubagentInvocation({})), /Provide an action/);
    assert.match(text(parseSubagentInvocation({ action: "explode" })), /Unknown action/);
  });

  it("parses the collected list filter and rejects the removed joined filter", () => {
    assert.deepEqual(parseSubagentInvocation({ action: "list", collected: true }), {
      action: "list",
      collected: true,
    });
    assert.match(text(parseSubagentInvocation({ action: "list", collected: "yes" })), /list collected must be a boolean/);
    assert.match(text(parseSubagentInvocation({ action: "list", joined: true })), /Property joined is not allowed/);
  });

  it("rejects a spawn task without a label", () => {
    const result = parseSubagentInvocation({ action: "spawn", spawns: [{ agent: "helper", prompt: "work" }] });
    assert.match(text(result), /label must be a non-empty string/);
  });

  for (const action of ["join", "cancel"] as const) {
    it(`reports duplicate subagentIds in ${action}`, () => {
      assert.match(text(parseSubagentInvocation({ action, subagentIds: [id, id] })), /Duplicate subagentId/);
    });
  }

  it("reports duplicate subagentIds in resume", () => {
    assert.match(text(parseSubagentInvocation({ action: "resume", resumes: [
      { subagentId: id, prompt: "one" }, { subagentId: id, prompt: "two" },
    ] })), /Duplicate subagentId/);
  });

  it("reports duplicate subagentIds in steer", () => {
    assert.match(text(parseSubagentInvocation({ action: "steer", messages: [
      { subagentId: id, message: "one" }, { subagentId: id, message: "two" },
    ] })), /Duplicate subagentId/);
  });

  it("distinguishes malformed and unknown plausible IDs", () => {
    assert.match(text(parseSubagentInvocation({ action: "join", subagentIds: ["Not-An-Id!"] })), /Invalid subagentId format/);
    assert.match(text(parseSubagentInvocation({ action: "join", subagentIds: ["hello-world"] })), /was not found/);
  });

  it("enforces maxTasks", () => {
    const invocation = { action: "spawn", spawns: [
      { agent: "helper", prompt: "one", label: "One" },
      { agent: "helper", prompt: "two", label: "Two" },
    ] };
    assert.match(text(parseSubagentInvocation(invocation, { maxTasks: 1 })), /Too many tasks/);
  });
});
