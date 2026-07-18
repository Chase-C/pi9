import { describe, expect, it } from "vitest";
import { formatWidgetLines } from "../../src/view/conversation-lines.js";
import { fakeAgent } from "../helpers/fake-agent.js";
describe("widget lines", () => { it("uses neutral run sections and ids", () => { const lines = formatWidgetLines([fakeAgent({ conversationId: "c1", runId: "r1", status: { kind: "running", startedAt: 1 } }), fakeAgent({ conversationId: "c2", runId: "r2" })]); expect(lines.join("\n")).toContain("Active Runs"); expect(lines.join("\n")).toContain("Completed Runs"); expect(lines.join("\n")).toContain("r1 · running"); }); });
