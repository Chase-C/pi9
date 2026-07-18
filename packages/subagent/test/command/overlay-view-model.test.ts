import { describe, expect, it } from "vitest";
import { projectConversations } from "../../src/command/overlay-view-model.js";
import { fakeAgent } from "../helpers/fake-agent.js";
describe("conversation projection", () => { it("keeps descendants whose parent was removed", () => { const child = fakeAgent({ conversationId: "child", parentConversationId: "removed" }); expect(projectConversations([child], { mode: "tree", query: "" })).toEqual([{ conversation: child, depth: 0 }]); }); });
