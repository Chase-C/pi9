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
const answered = (question: string, answer: unknown) => ({ status: "answered", question, answer });

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
      result(answered("Choose", {
        selections: [
          { label: "Beta", description: "Second", comment: "Safest" },
          { label: "Gamma", description: "Third" },
        ],
        freeform: "Ship Friday",
      })),
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
              answered: true,
              allowMultiple: true,
            },
          },
        ],
      },
      {
        ...messages[1],
        content: [{ type: "text", text: "Selected: Beta — Second (Safest), Gamma — Third; response: Ship Friday" }],
      },
    ]);
  });

  it("does not retain irrelevant multiplicity for a single selection", () => {
    const messages = [
      call({ question: "Choose", options: [{ label: "A" }, { label: "B" }], allowMultiple: true }),
      result(answered("Choose", { selections: [{ label: "A" }] })),
    ];

    const rewritten = rewriteAskContext(messages) as any[];
    expect(rewritten[0].content[1].arguments).toEqual({ question: "Choose", answered: true });
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
    { label: "unrelated calls", messages: [call({ question: "Q" }, "other", "read"), result(answered("Q", { selections: [{ label: "A" }] }), "other")] },
    { label: "unmatched calls", messages: [call({ question: "Q" }), result(answered("Q", { selections: [{ label: "A" }] }), "different")] },
    { label: "malformed details", messages: [call({ question: "Q" }), result(answered("Q", { selections: "A" }))] },
    { label: "UI-unavailable errors", messages: [call({ question: "Q" }), { ...result(undefined), isError: true }] },
  ])("leaves $label unchanged", ({ messages }) => {
    expect(rewriteAskContext(messages)).toEqual(messages);
  });

  const replay = (details: unknown, timestamp?: number) => ({
    role: "custom", customType: "ask:reanswer", content: "replayed", details,
    ...(timestamp !== undefined ? { timestamp } : {}),
  });
  const replayDetails = (overrides: Record<string, unknown> = {}) => ({
    toolCallId: "ask-1",
    question: "Choose",
    context: "Release",
    allowMultiple: false,
    answer: { selections: [{ label: "B" }] },
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
      answered: true,
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
      call({ question: "Choose", context: "Release", answered: true }),
      {
        role: "toolResult",
        toolCallId: "ask-1",
        toolName: "ask",
        content: [{ type: "text", text: "Selected: B — Second" }],
        details: answered("Choose", { selections: [{ label: "B" }] }),
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
      call({ question: "Choose", context: "Release", answered: true }),
      expect.objectContaining({ role: "toolResult", toolCallId: "ask-1" }),
      summary,
    ]);
  });

  it("projects a submitted empty replay as a successful no-answer result", () => {
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      replay(replayDetails({ answer: { selections: [] } }), 99),
    ];

    expect(rewriteAskContext(messages)).toEqual([
      call({ question: "Choose", context: "Release", answered: true }),
      {
        role: "toolResult",
        toolCallId: "ask-1",
        toolName: "ask",
        content: [{ type: "text", text: "No answer provided." }],
        details: answered("Choose", { selections: [] }),
        isError: false,
        timestamp: 99,
      },
    ]);
  });

  it("preserves replay comments and freeform answers in the result", () => {
    const answer = {
      selections: [{ label: "A", comment: "because" }, { label: "B" }],
      freeform: "extra",
    };
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "A" }, { label: "B" }], allowMultiple: true }),
      replay(replayDetails({ allowMultiple: true, answer })),
    ];

    const rewritten = rewriteAskContext(messages) as any[];
    expect(rewritten[0].content[1].arguments).toEqual({
      question: "Choose", context: "Release", answered: true, allowMultiple: true,
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
      replay(replayDetails({ answer: { selections: [{ label: "A" }, { label: "B" }] } })),
    ]],
    ["freeform when disallowed", [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }], allowFreeform: false }),
      replay(replayDetails({ answer: { selections: [{ label: "B" }], freeform: "extra" } })),
    ]],
  ])("leaves an ambiguous or impossible replay unchanged: %s", (_label, messages) => {
    expect(rewriteAskContext(messages)).toEqual(messages);
  });

  it.each([
    ["malformed", replay(replayDetails({ answer: { selections: "B" } }))],
    ["unmatched", replay(replayDetails({ toolCallId: "missing" }))],
  ])("leaves %s replay messages unchanged", (_label, marker) => {
    const messages = [call({ question: "Choose", context: "Release", options: [{ label: "B" }] }), marker];
    expect(rewriteAskContext(messages)).toEqual(messages);
  });

  it("reuses a native result instead of synthesizing a duplicate", () => {
    const native = result(answered("Choose", { selections: [{ label: "B" }] }));
    const marker = replay(replayDetails());
    const messages = [call({ question: "Choose", context: "Release", options: [{ label: "B" }] }), native, marker];

    const rewritten = rewriteAskContext(messages) as any[];
    expect(rewritten).toHaveLength(2);
    expect(rewritten[1]).toMatchObject({ role: "toolResult", toolCallId: "ask-1", details: answered("Choose", replayDetails().answer) });
    expect(rewritten.filter(message => message.role === "toolResult")).toHaveLength(1);
  });
});
