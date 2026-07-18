import { describe, expect, it } from "vitest";
import { formatSubagentToolLines, runDetails, runsStartedDetails } from "../../src/view/format.js";
import { fakeAgent } from "../helpers/fake-agent.js";
describe("conversation rendering", () => { it("renders immediate run handles with both ids", () => { const lines = formatSubagentToolLines(runsStartedDetails([fakeAgent({ conversationId: "c1", runId: "r1" })])); expect(lines.join("\n")).toContain("r1 · c1"); }); it("renders full joined output", () => { expect(formatSubagentToolLines(runDetails([fakeAgent({ status: { kind: "completed", response: "full output" } })])).join("\n")).toContain("full output"); }); });
