import { describe, expect, it } from "vitest";
import { formatWidgetLines } from "../../src/widget.js";
import { fakeAgent } from "../helpers/fake-agent.js";

describe("summary widget", () => {
  it("counts running, queued, and retained conversations", () => {
    const lines = formatWidgetLines([
      fakeAgent({ conversationId: "c1", status: { kind: "running", startedAt: 1 } }),
      fakeAgent({ conversationId: "c2", status: { kind: "queued", queuedAt: 1 } }),
      fakeAgent({ conversationId: "c3" }),
    ]);

    expect(lines).toEqual(["Subagents  1 running · 1 queued · 3 retained"]);
  });

  it("omits zero-valued active counts", () => {
    expect(formatWidgetLines([fakeAgent({ conversationId: "retained" })]))
      .toEqual(["Subagents  1 retained"]);
  });

  it("counts active conversations as retained", () => {
    expect(formatWidgetLines([fakeAgent({ status: { kind: "running", startedAt: 1 } })]))
      .toEqual(["Subagents  1 running · 1 retained"]);
  });

  it("retains settled conversations without active counts", () => {
    expect(formatWidgetLines([
      fakeAgent({ conversationId: "completed" }),
      fakeAgent({ conversationId: "failed", status: { kind: "error" } }),
    ])).toEqual(["Subagents  2 retained"]);
  });

  it("clears when no conversations remain", () => {
    expect(formatWidgetLines([])).toEqual([]);
  });
});
