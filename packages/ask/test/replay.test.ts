import type { SessionEntry, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { rewriteAskContext } from "../src/context.js";
import { renderAskReanswerMessage } from "../src/replay-renderer.js";
import {
  ASK_REPLAY_CUSTOM_TYPE,
  buildAskReplayMessage,
  resolveAskReplayTarget,
} from "../src/replay.js";

const args = { question: "  Choose? ", options: [{ label: " A " }] };
const assistant = (id: string, calls: Array<{ name: string; arguments: unknown }>): SessionEntry => ({
  type: "message", id, parentId: null, timestamp: "now",
  message: {
    role: "assistant",
    content: calls.map((call, index) => ({ type: "toolCall", id: `call-${index}`, ...call })),
  } as never,
});
const event = (newLeafId: string | null, summaryEntry?: SessionTreeEvent["summaryEntry"]): SessionTreeEvent => ({
  type: "session_tree", newLeafId, oldLeafId: "old", ...(summaryEntry ? { summaryEntry } : {}),
});
const lookup = (entries: SessionEntry[]) => (id: string) => entries.find((entry) => entry.id === id);

describe("replay records", () => {
  it("builds versioned, normalized custom message data", () => {
    expect(ASK_REPLAY_CUSTOM_TYPE).toBe("ask:reanswer");
    const message = buildAskReplayMessage("call-1", args, { selections: [{ label: "A" }] });
    expect(message).toEqual({
      customType: "ask:reanswer",
      content: "Re-answer: Choose?",
      display: true,
      details: {
        version: 1,
        toolCallId: "call-1",
        question: "Choose?",
        allowMultiple: false,
        answer: { cancelled: false, selections: [{ label: "A" }] },
      },
    });

    const projected = rewriteAskContext([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: args }] },
      { role: "custom", timestamp: 12, ...message },
    ]) as any[];
    expect(projected[1]).toMatchObject({ role: "toolResult", toolCallId: "call-1", isError: false, timestamp: 12 });
    expect(renderAskReanswerMessage(message, { expanded: false }, undefined).render(80).join("\n")).toContain("Selected: A");
  });
});

describe("resolveAskReplayTarget", () => {
  it("resolves a direct assistant Ask leaf and normalizes its stored arguments", () => {
    const entry = assistant("ask-1", [{ name: "ask", arguments: args }]);
    expect(resolveAskReplayTarget(event("ask-1"), lookup([entry]))).toEqual({
      status: "resolved", sourceEntryId: "ask-1",
      params: { question: "Choose?", options: [{ label: "A" }], allowMultiple: false, allowFreeform: true },
    });
  });

  it("resolves only the parent of a branch-summary leaf", () => {
    const selected = assistant("ask-1", [{ name: "ask", arguments: args }]);
    const summary = { type: "branch_summary", id: "summary", parentId: "ask-1", timestamp: "now", fromId: "x", summary: "s" } as const;
    expect(resolveAskReplayTarget(event("summary", summary), lookup([selected]))).toMatchObject({ status: "resolved", sourceEntryId: "ask-1" });
    expect(resolveAskReplayTarget(event("summary", { ...summary, parentId: "middle" }), lookup([
      { type: "custom", id: "middle", parentId: "ask-1", timestamp: "now", customType: "x" }, selected,
    ]))).toEqual({ status: "not-replayable", reason: "not-assistant" });
  });

  it.each([
    [event(null), [], "no-entry"],
    [event("missing"), [], "no-entry"],
    [event("result"), [{ type: "message", id: "result", parentId: null, timestamp: "now", message: { role: "toolResult" } as never }], "not-assistant"],
    [event("custom"), [{ type: "custom_message", id: "custom", parentId: null, timestamp: "now", customType: "ask:reanswer", content: "x", display: true }], "not-assistant"],
    [event("other"), [assistant("other", [{ name: "read", arguments: {} }])], "not-ask"],
    [event("many"), [assistant("many", [{ name: "ask", arguments: args }, { name: "ask", arguments: args }])], "multiple-tool-calls"],
    [event("mixed"), [assistant("mixed", [{ name: "ask", arguments: args }, { name: "read", arguments: {} }])], "mixed-tools"],
    [event("bad"), [assistant("bad", [{ name: "ask", arguments: { question: " " } }])], "invalid-arguments"],
  ] as const)("rejects non-replayable target %#", (treeEvent, entries, reason) => {
    expect(resolveAskReplayTarget(treeEvent, lookup(entries as unknown as SessionEntry[]))).toEqual({ status: "not-replayable", reason });
  });
});
