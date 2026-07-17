import type { SessionEntry, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  ASK_REPLAY_CUSTOM_TYPE,
  buildAskReplayMessage,
  parseStoredAsk,
  resolveAskReplayTarget,
  rewriteAskContext,
} from "../src/session.js";

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
const lookup = (entries: SessionEntry[]) => (id: string) => entries.find(entry => entry.id === id);

describe("replay records", () => {
  it("retains previews only in source arguments", () => {
    const previewSentinel = "REPLAY_PREVIEW_SENTINEL";
    const storedArgs = {
      question: "Choose?",
      options: [{ label: "A", preview: previewSentinel }],
    };
    const storedAsk = parseStoredAsk(storedArgs);
    expect(storedAsk?.options[0]?.preview).toBe(previewSentinel);

    const source = assistant("ask-with-preview", [{ name: "ask", arguments: storedArgs }]);
    const resolution = resolveAskReplayTarget(event("ask-with-preview"), lookup([source]));
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.ask.options[0]?.preview).toBe(previewSentinel);

    const message = buildAskReplayMessage("call-0", { selections: [{ option: 0 }] });
    expect(JSON.stringify(message.details)).not.toContain(previewSentinel);
  });

  it("builds a minimal hidden replay record", () => {
    expect(ASK_REPLAY_CUSTOM_TYPE).toBe("ask:reanswer");
    const message = buildAskReplayMessage("call-1", { selections: [{ option: 0 }] });
    expect(message).toEqual({
      customType: "ask:reanswer",
      content: "",
      display: false,
      details: { toolCallId: "call-1", answer: { selections: [{ option: 0 }] } },
    });

    const projected = rewriteAskContext([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: args }] },
      { role: "custom", timestamp: 12, ...message },
    ] as never) as any[];
    expect(JSON.parse(projected[0].content)).toEqual({
      type: "ask_response",
      question: "Choose?",
      selectionMode: "single",
      answer: { selections: [{ label: "A" }] },
    });
  });
});

describe("resolveAskReplayTarget", () => {
  it("resolves a direct assistant Ask leaf and normalizes its stored arguments", () => {
    const entry = assistant("ask-1", [{ name: "ask", arguments: args }]);
    expect(resolveAskReplayTarget(event("ask-1"), lookup([entry]))).toEqual({
      status: "resolved", toolCallId: "call-0",
      ask: { question: "Choose?", options: [{ label: "A" }], allowMultiple: false, allowFreeform: true },
    });
  });

  it("resolves the visible Ask tool-result row to its assistant call", () => {
    const selected = assistant("ask-1", [{ name: "ask", arguments: args }]);
    const result = {
      type: "message", id: "result-1", parentId: "ask-1", timestamp: "now",
      message: { role: "toolResult", toolCallId: "call-0", toolName: "ask" } as never,
    } satisfies SessionEntry;
    expect(resolveAskReplayTarget(event("result-1"), lookup([selected, result]))).toMatchObject({
      status: "resolved", toolCallId: "call-0",
    });
  });

  it("resolves only the parent of a branch-summary leaf", () => {
    const selected = assistant("ask-1", [{ name: "ask", arguments: args }]);
    const summary = { type: "branch_summary", id: "summary", parentId: "ask-1", timestamp: "now", fromId: "x", summary: "s" } as const;
    expect(resolveAskReplayTarget(event("summary", summary), lookup([selected]))).toMatchObject({ status: "resolved", toolCallId: "call-0" });
    expect(resolveAskReplayTarget(event("summary", { ...summary, parentId: "middle" }), lookup([
      { type: "custom", id: "middle", parentId: "ask-1", timestamp: "now", customType: "x" }, selected,
    ]))).toEqual({ status: "not-replayable", reason: "not-assistant" });
  });

  it("uses a revision instead of the native result retained by tool-row navigation", () => {
    const message = buildAskReplayMessage("call-1", { selections: [{ option: 1 }] });
    const projected = rewriteAskContext([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: { question: "Choose?", options: [{ label: "A" }, { label: "B" }] } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "ask", content: [{ type: "text", text: "Selected: A" }], details: { status: "answered", answer: { selections: [{ option: 0 }] } }, isError: false },
      { role: "custom", timestamp: 12, ...message },
    ] as never) as any[];

    expect(JSON.parse(projected[0].content).answer).toEqual({ selections: [{ label: "B" }] });
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
