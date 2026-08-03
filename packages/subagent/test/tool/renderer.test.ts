import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderSubagentCall, renderSubagentResult } from "../../src/tool-renderer.js";

const id = "airy-acorn";
const output = (details: unknown, expanded = false, content = "fallback") =>
  renderSubagentResult({ details: details as any, content: [{ type: "text", text: content }] }, { expanded }).render(120).join("\n");

function expectViews(details: unknown, collapsed: string, expanded: string): void {
  assert.match(output(details), new RegExp(collapsed));
  assert.match(output(details, true), new RegExp(expanded));
}

describe("subagent result renderer", () => {
  it("renders agents", () => expectViews({ response: { action: "agents", results: [
    { name: "helper", description: "Helps", source: "project" },
  ] } }, "Found 1 available agent", "helper.*project"));

  it("renders list", () => expectViews({ response: { action: "list", results: [
    { subagentId: id, agent: "helper", label: "Worker", status: "running", actionHints: [], descendants: [] },
  ] } }, "Found 1 subagent", "Worker.*running"));

  it("renders spawn", () => expectViews({ response: { action: "spawn", results: [{}] }, view: { tasks: [
    { inputIndex: 0, kind: "spawn", agent: "helper", label: "Worker", prompt: "Do work", subagentId: id },
  ] } }, "Started 1 new subagent", "started.*airy-acorn"));

  it("renders cancel", () => expectViews({ response: { action: "cancel", results: [
    { subagentId: id, status: "cancelled" },
  ] } }, "Cancelled 1 subagent", "airy-acorn.*cancelled"));

  it("renders inspect", () => expectViews({ response: { action: "inspect", results: [
    { subagentId: id, agent: "helper", label: "Worker", status: "running", generation: 1,
      metrics: { elapsedMs: 2, turns: 1, compactions: 0, tokens: 3 },
      totalMetrics: { elapsedMs: 2, turns: 1, compactions: 0, tokens: 3 }, history: [], recentTools: [], steers: [] },
  ] } }, "Inspected 1 subagent", "generation 1"));

  it("renders join", () => expectViews({ response: { action: "join", results: [{}] }, view: { entries: [
    { subagentId: id, agent: "helper", label: "Worker", status: "completed", output: "done" },
  ] } }, "Worker.*completed", "subagent airy-acorn"));

  it("omits generation kind from join rendering", () => {
    for (const kind of ["spawn", "resume"]) {
      const details = { response: { action: "join", results: [{}] }, view: { entries: [
        { subagentId: id, agent: "helper", label: "Worker", kind, status: "completed", output: "done" },
      ] } };
      assert.doesNotMatch(output(details), new RegExp(kind));
      assert.doesNotMatch(output(details, true), new RegExp(kind));
    }
  });

  it("does not render nullable join output as text", () => {
    const details = {
      response: { action: "join", results: [{ subagentId: id, status: "cancelled", output: null }] },
      view: { entries: [{ subagentId: id, agent: "helper", label: "Worker", status: "cancelled" }] },
    };
    assert.doesNotMatch(output(details, true), /null/);
  });

  it("renders remove", () => expectViews({ response: { action: "remove", results: [
    { ok: true, removedIds: [id] },
  ] } }, "Removed 1 subagent", "airy-acorn.*removed"));

  it("falls back for persisted legacy details", () => {
    assert.equal(output({ action: "spawn", tasks: [] }, false, "raw legacy content").trimEnd(), "raw legacy content");
  });

  it("renders error envelopes", () => {
    assert.equal(output({ response: { action: "unknown", error: "boom" } }).trimEnd(), "boom");
  });
});

describe("subagent call renderer", () => {
  it("renders the action and task count", () => {
    const rendered = renderSubagentCall({ action: "spawn", spawns: [{}, {}] }).render(120).join("\n");
    assert.match(rendered, /subagent spawn/);
    assert.match(rendered, /2 tasks/);
  });
});
