import { test } from "vitest";
import assert from "node:assert/strict";

import subagentExtension from "../../src/index.js";
import { fakeAgent } from "../helpers/fake-agent.js";

function registerExtension() {
  let registeredTool: any;
  subagentExtension({ registerTool: (tool: any) => { registeredTool = tool; } } as any);
  return registeredTool;
}

const passthroughTheme = { fg: (_color: string, text: string) => text };

function render(details: any, expanded: boolean): string {
  const tool = registerExtension();
  const component = tool.renderResult(
    { content: [{ type: "text", text: JSON.stringify(details) }], details },
    { expanded },
    passthroughTheme,
  );
  return component.render(120).join("\n");
}

test("results collapsed renders one run-style row per entry, including pending and bad-id entries", () => {
  const details = {
    view: "results",
    results: [
      { snapshot: fakeAgent({ id: "s1", config: { name: "alpha" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }) },
      { snapshot: fakeAgent({ id: "s2", config: { name: "beta" }, status: { kind: "running", startedAt: 1 } }) },
      { sessionId: "s3", error: "Unknown subagent session: s3" },
    ],
  };

  const lines = render(details, false).split("\n");

  assert.equal(lines.length, 3);
  assert.match(lines[0], /^  ✓ alpha /);
  assert.match(lines[1], /beta /);
  assert.equal(lines[2], "s3 · error: Unknown subagent session: s3");
  // No count-summary header — the header is the tool-call title line.
  assert.doesNotMatch(lines.join("\n"), /\d results?\b/);
});

test("results collapsed renders a lone completed entry as a single row with no count header", () => {
  const details = {
    view: "results",
    results: [
      { snapshot: fakeAgent({ id: "s1", config: { name: "alpha" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "ok" } }) },
    ],
  };

  const rendered = render(details, false);

  assert.match(rendered, /^  ✓ alpha /);
  assert.doesNotMatch(rendered, /\d results?\b/);
  assert.doesNotMatch(rendered, /running|queued|error/);
});

test("results expanded renders each entry as a run-style block, with pending rows and bad-id errors", () => {
  const details = {
    view: "results",
    results: [
      { snapshot: fakeAgent({ id: "ready-id", label: "phase 1", config: { name: "helper", resumable: true }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "all done" } }) },
      { snapshot: fakeAgent({ id: "queued-id", label: "phase 2", config: { name: "helper" }, status: { kind: "queued", queuedAt: 1 } }) },
      { sessionId: "err-id", error: "Unknown subagent session: err-id" },
    ],
  };

  const rendered = render(details, true);

  assert.match(rendered, /✓ helper  phase 1/);
  assert.match(rendered, /all done/);
  assert.match(rendered, /○ helper  phase 2/);
  assert.match(rendered, /err-id · error: Unknown subagent session: err-id/);
  // Run-style rows convey status by glyph and no longer surface the raw session handle.
  assert.doesNotMatch(rendered, /session:ready-id/);
});

test("results expanded omits session label for ready entries without a collectable session id", () => {
  const details = {
    view: "results",
    results: [
      { snapshot: fakeAgent({ id: "x", config: { name: "helper" }, status: { kind: "completed", startedAt: 1, completedAt: 2, response: "all done" } }) },
    ],
  };

  const rendered = render(details, true);

  assert.match(rendered, /helper/);
  assert.match(rendered, /all done/);
  assert.doesNotMatch(rendered, /session:/);
});
