import { describe, expect, it } from "vitest";
import { projectConversations } from "../../src/command/overlay-view-model.js";
import { fakeAgent } from "../helpers/fake-agent.js";
describe("conversation projection", () => { it("keeps descendants whose parent was removed", () => { const child = fakeAgent({ conversationId: "child", parent: { conversationId: "removed", runId: "removed-run" } }); expect(projectConversations([child])).toEqual([{ conversation: child, depth: 0 }]); }); });
