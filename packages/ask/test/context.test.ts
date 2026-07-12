import { describe, expect, it } from "vitest";
import { rewriteAskContext } from "../src/context.js";

const call = (args: unknown, id = "ask-1", name = "ask") => ({
  role: "assistant",
  content: [{ type: "text", text: "before" }, { type: "toolCall", id, name, arguments: args }],
});

const result = (details: unknown, id = "ask-1") => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "ask",
  content: [{ type: "text", text: "the original verbose result" }],
  details,
});

describe("rewriteAskContext", () => {
  it("keeps only selected option details and summarizes a successful answer", () => {
    const messages = [
      call({
        question: "Choose",
        context: "For the release",
        options: [
          { label: "Alpha", description: "First" },
          { label: "Beta", description: "Second" },
          { label: "Gamma", description: "Third" },
        ],
        allowMultiple: true,
        allowFreeform: true,
      }),
      result({
        cancelled: false,
        selections: [
          { label: "Beta", description: "Second", comment: "Safest" },
          { label: "Gamma", description: "Third" },
        ],
        freeform: "Ship Friday",
      }),
    ];

    expect(rewriteAskContext(messages)).toEqual([
      {
        ...messages[0],
        content: [
          { type: "text", text: "before" },
          {
            type: "toolCall",
            id: "ask-1",
            name: "ask",
            arguments: {
              question: "Choose",
              context: "For the release",
              options: [
                { label: "Beta", description: "Second", comment: "Safest" },
                { label: "Gamma", description: "Third" },
              ],
              allowMultiple: true,
              freeform: "Ship Friday",
            },
          },
        ],
      },
      {
        ...messages[1],
        content: [{ type: "text", text: "Selected: Beta (Safest), Gamma; response: Ship Friday" }],
      },
    ]);
  });

  it("does not retain irrelevant multiplicity for a single selection", () => {
    const messages = [
      call({ question: "Choose", options: [{ label: "A" }, { label: "B" }], allowMultiple: true }),
      result({ cancelled: false, selections: [{ label: "A" }] }),
    ];

    const rewritten = rewriteAskContext(messages) as any[];
    expect(rewritten[0].content[1].arguments).toEqual({ question: "Choose", options: [{ label: "A" }] });
    expect(rewritten[1].content[0].text).toBe("Selected: A");
  });

  it("is pure and leaves cancelled asks, including alternatives, unchanged", () => {
    const messages = [
      call({ question: "Choose", options: [{ label: "A" }, { label: "B" }] }),
      result({ cancelled: true, selections: [] }),
    ];
    const snapshot = structuredClone(messages);

    const rewritten = rewriteAskContext(messages);

    expect(rewritten).toEqual(snapshot);
    expect(messages).toEqual(snapshot);
    expect(rewritten).not.toBe(messages);
  });

  it.each([
    { label: "unrelated calls", messages: [call({ question: "Q" }, "other", "read"), result({ cancelled: false, selections: [{ label: "A" }] }, "other")] },
    { label: "unmatched calls", messages: [call({ question: "Q" }), result({ cancelled: false, selections: [{ label: "A" }] }, "different")] },
    { label: "malformed details", messages: [call({ question: "Q" }), result({ cancelled: false, selections: "A" })] },
    { label: "UI-unavailable errors", messages: [call({ question: "Q" }), { ...result(undefined), isError: true }] },
  ])("leaves $label unchanged", ({ messages }) => {
    expect(rewriteAskContext(messages)).toEqual(messages);
  });

  const replay = (details: unknown, timestamp?: number) => ({
    role: "custom", customType: "ask:reanswer", content: "replayed", details,
    ...(timestamp !== undefined ? { timestamp } : {}),
  });
  const replayDetails = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    toolCallId: "ask-1",
    question: "Choose",
    context: "Release",
    allowMultiple: false,
    answer: { cancelled: false, selections: [{ label: "B" }] },
    ...overrides,
  });

  it("matches a normalized replay marker against whitespace-padded stored arguments", () => {
    const messages = [
      call({
        question: "  Choose  ",
        context: "  Release  ",
        options: [{ label: "  B  ", description: "  Second  " }],
        allowMultiple: false,
      }),
      replay(replayDetails()),
    ];

    const rewritten = rewriteAskContext(messages) as any[];
    expect(rewritten[0].content[1].arguments).toEqual({
      question: "Choose",
      context: "Release",
      options: [{ label: "B", description: "Second" }],
    });
    expect(rewritten[1]).toMatchObject({ role: "toolResult", toolCallId: "ask-1" });
  });

  it("replaces a replay marker with a synthetic result immediately after its ask call", () => {
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "A" }, { label: "B", description: "Second" }] }),
      replay(replayDetails(), 1_234),
    ];
    const snapshot = structuredClone(messages);

    expect(rewriteAskContext(messages)).toEqual([
      call({ question: "Choose", context: "Release", options: [{ label: "B", description: "Second" }] }),
      {
        role: "toolResult",
        toolCallId: "ask-1",
        toolName: "ask",
        content: [{ type: "text", text: "Selected: B" }],
        details: { cancelled: false, selections: [{ label: "B" }] },
        isError: false,
        timestamp: 1_234,
      },
    ]);
    expect(messages).toEqual(snapshot);
  });

  it("moves an intervening branch summary behind the synthetic result", () => {
    const summary = { role: "branchSummary", content: "Earlier branch" };
    const messages = [call({ question: "Choose", context: "Release", options: [{ label: "B" }] }), summary, replay(replayDetails())];

    expect(rewriteAskContext(messages)).toEqual([
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      expect.objectContaining({ role: "toolResult", toolCallId: "ask-1" }),
      summary,
    ]);
  });

  it("projects a submitted empty replay as a successful no-answer result", () => {
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      replay(replayDetails({ answer: { cancelled: false, selections: [] } }), 99),
    ];

    expect(rewriteAskContext(messages)).toEqual([
      call({ question: "Choose", context: "Release" }),
      {
        role: "toolResult",
        toolCallId: "ask-1",
        toolName: "ask",
        content: [{ type: "text", text: "No answer provided." }],
        details: { cancelled: false, selections: [] },
        isError: false,
        timestamp: 99,
      },
    ]);
  });

  it("preserves replay comments and freeform answers in selected-only arguments", () => {
    const answer = {
      cancelled: false,
      selections: [{ label: "A", comment: "because" }, { label: "B" }],
      freeform: "extra",
    };
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "A" }, { label: "B" }], allowMultiple: true }),
      replay(replayDetails({ allowMultiple: true, answer })),
    ];

    const rewritten = rewriteAskContext(messages) as any[];
    expect(rewritten[0].content[1].arguments).toEqual({
      question: "Choose", context: "Release", options: [{ label: "A", comment: "because" }, { label: "B" }], allowMultiple: true, freeform: "extra",
    });
    expect(rewritten[1].content[0].text).toBe("Selected: A (because), B; response: extra");
  });

  it.each([
    ["duplicate call IDs", [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      replay(replayDetails()),
    ]],
    ["an Ask mixed with another tool call", [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "ask-1", name: "ask", arguments: { question: "Choose", context: "Release", options: [{ label: "B" }] } },
          { type: "toolCall", id: "read-1", name: "read", arguments: {} },
        ],
      },
      replay(replayDetails()),
    ]],
    ["multiple Ask calls in one message", [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "ask-1", name: "ask", arguments: { question: "Choose", context: "Release", options: [{ label: "B" }] } },
          { type: "toolCall", id: "ask-2", name: "ask", arguments: { question: "Other" } },
        ],
      },
      replay(replayDetails()),
    ]],
    ["an unknown selected label", [
      call({ question: "Choose", context: "Release", options: [{ label: "A" }] }),
      replay(replayDetails()),
    ]],
    ["multiple selections when disallowed", [
      call({ question: "Choose", context: "Release", options: [{ label: "A" }, { label: "B" }] }),
      replay(replayDetails({ answer: { cancelled: false, selections: [{ label: "A" }, { label: "B" }] } })),
    ]],
    ["freeform when disallowed", [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }], allowFreeform: false }),
      replay(replayDetails({ answer: { cancelled: false, selections: [{ label: "B" }], freeform: "extra" } })),
    ]],
  ])("leaves an ambiguous or impossible replay unchanged: %s", (_label, messages) => {
    expect(rewriteAskContext(messages)).toEqual(messages);
  });

  it.each([
    ["malformed", replay(replayDetails({ answer: { cancelled: false, selections: "B" } }))],
    ["version mismatch", replay(replayDetails({ version: 2 }))],
    ["unmatched", replay(replayDetails({ toolCallId: "missing" }))],
  ])("leaves %s replay messages unchanged", (_label, marker) => {
    const messages = [call({ question: "Choose", context: "Release", options: [{ label: "B" }] }), marker];
    expect(rewriteAskContext(messages)).toEqual(messages);
  });

  it("leaves native results unaffected and does not synthesize a duplicate", () => {
    const native = result({ cancelled: false, selections: [{ label: "B" }] });
    const marker = replay(replayDetails());
    const messages = [call({ question: "Choose", context: "Release", options: [{ label: "B" }] }), native, marker];

    const rewritten = rewriteAskContext(messages);
    expect(rewritten).toHaveLength(3);
    expect(rewritten[2]).toEqual(marker);
    expect((rewritten as any[]).filter(message => message.role === "toolResult")).toHaveLength(1);
  });
});
