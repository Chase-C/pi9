import { describe, expect, it } from "vitest";
import { buildWidgetModel, renderWidgetModelLines } from "../../src/view/conversation-lines.js";
import { fakeAgent } from "../helpers/fake-agent.js";
describe("widget layout", () => { it("preserves stacked and column layout behavior", () => { const model = buildWidgetModel([fakeAgent({ status: { kind: "running" } }), fakeAgent({ conversationId: "c2", runId: "r2" })]); expect(renderWidgetModelLines(model, 1, undefined, { layout: "stacked", width: 80 })).toContain("Completed Runs"); expect(renderWidgetModelLines(model, 1, undefined, { layout: "columns", width: 80 })[0]).toContain("│"); }); });
