import { describe, expect, it } from "vitest";
import { serializeInventoryForModel } from "../../src/view/serialize.js";
import { fakeAgent } from "../helpers/fake-agent.js";
describe("inventory serialization", () => { it("is flat and output-free", () => { const value = serializeInventoryForModel([fakeAgent({ conversationId: "c1", runId: "r1", label: "work", capabilities: { canResume: true, canRemove: true } })]); expect(value.runs).toEqual([expect.objectContaining({ conversationId: "c1", runId: "r1", label: "work", isLatestRun: true, acknowledged: false, canJoin: true, canResume: true, canRemove: true })]); expect(JSON.stringify(value)).not.toContain("done"); }); });
