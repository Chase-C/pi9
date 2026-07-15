import { describe, expect, it } from "vitest";
import { rewriteAskContext } from "../src/context.js";

const rewrite = (messages: readonly unknown[]) => rewriteAskContext(messages as never);

const call = (args: unknown, id = "ask-1", name = "ask") => ({
  role: "assistant",
  content: [{ type: "text", text: "before" }, { type: "toolCall", id, name, arguments: args }],
  timestamp: 100,
});

const result = (details: unknown, id = "ask-1", timestamp = 200) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "ask",
  content: [{ type: "text", text: "the original verbose result" }],
  details,
  isError: false,
  timestamp,
});

const answered = (question: string, answer: unknown) => ({ status: "answered", question, answer });
const replay = (details: unknown, timestamp = 300) => ({
  role: "custom", customType: "ask:reanswer", content: "replayed", display: false, details, timestamp,
});
const replayDetails = (overrides: Record<string, unknown> = {}) => ({
  toolCallId: "ask-1",
  question: "Choose",
  context: "Release",
  allowMultiple: false,
  answer: { selections: [{ label: "B" }] },
  ...overrides,
});
const summary = (payload: unknown, timestamp: number) => ({
  role: "custom",
  customType: "ask:summary",
  display: false,
  content: JSON.stringify(payload),
  timestamp,
});

const payload = (
  question: string,
  selectionMode: "single" | "multi",
  selections: unknown[],
  context?: string,
  freeform?: string,
) => ({
  type: "ask_response",
  question,
  ...(context === undefined ? {} : { context }),
  selectionMode,
  answer: { selections, ...(freeform === undefined ? {} : { freeform }) },
});

describe("rewriteAskContext", () => {
  it("replaces a standalone native Ask call and result with a concise summary", () => {
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
          { label: "Beta", comment: "Safest" },
          { label: "Gamma" },
        ],
        freeform: "Ship Friday",
      }), "ask-1", 500),
    ];
    const snapshot = structuredClone(messages);

    expect(rewrite(messages)).toEqual([
      summary(payload("Choose", "multi", [
        { label: "Beta", description: "Second", comment: "Safest" },
        { label: "Gamma", description: "Third" },
      ], "For the release", "Ship Friday"), 500),
    ]);
    expect(messages).toEqual(snapshot);
  });

  it("never projects authored preview content into the compact context summary", () => {
    const previewSentinel = "CONTEXT_PREVIEW_SENTINEL";
    const rewritten = rewrite([
      call({
        question: "Choose",
        options: [{ label: "A", preview: previewSentinel }],
      }),
      result(answered("Choose", { selections: [{ label: "A" }] })),
    ]);

    expect(JSON.stringify(rewritten)).not.toContain(previewSentinel);
    const projectedPayload = JSON.parse((rewritten[0] as any).content);
    expect(projectedPayload.answer).toEqual({ selections: [{ label: "A" }] });
  });

  it("uses single mode and omits absent optional payload fields", () => {
    const messages = [
      call({ question: "Choose", options: [{ label: "A" }, { label: "B" }] }),
      result(answered("Choose", { selections: [{ label: "A" }] }), "ask-1", 600),
    ];

    const rewritten = rewrite(messages);
    expect(rewritten).toEqual([
      summary(payload("Choose", "single", [{ label: "A" }]), 600),
    ]);
    const projectedPayload = JSON.parse((rewritten[0] as any).content);
    expect(projectedPayload).not.toHaveProperty("context");
    expect(projectedPayload.answer.selections[0]).not.toHaveProperty("description");
    expect(projectedPayload.answer.selections[0]).not.toHaveProperty("comment");
    expect(projectedPayload).not.toHaveProperty("declined");
  });

  it("leaves cancelled, errored, malformed, unmatched, and non-standalone native asks unchanged", () => {
    const cases = [
      ["cancelled", [call({ question: "Q" }), result({ status: "cancelled", question: "Q" })]],
      ["UI unavailable", [call({ question: "Q" }), result({ status: "ui_unavailable", question: "Q" })]],
      ["errored", [call({ question: "Q" }), { ...result(answered("Q", { selections: [{ label: "A" }] })), isError: true }]],
      ["malformed details", [call({ question: "Q" }), result(answered("Q", { selections: "A" }))]],
      ["unmatched result", [call({ question: "Q" }), result(answered("Q", { selections: [{ label: "A" }] }), "different")]],
      ["incomplete", [call({ question: "Q" })]],
      ["mixed tools", [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "ask-1", name: "ask", arguments: { question: "Q", options: [{ label: "A" }] } },
            { type: "toolCall", id: "read-1", name: "read", arguments: {} },
          ],
        },
        result(answered("Q", { selections: [{ label: "A" }] })),
      ]],
      ["multiple Ask calls", [{
        role: "assistant",
        content: [
          { type: "toolCall", id: "ask-1", name: "ask", arguments: { question: "Q", options: [{ label: "A" }] } },
          { type: "toolCall", id: "ask-2", name: "ask", arguments: { question: "Other" } },
        ],
      }, result(answered("Q", { selections: [{ label: "A" }] }))]],
      ["duplicate native results", [
        call({ question: "Q", options: [{ label: "A" }] }),
        result(answered("Q", { selections: [{ label: "A" }] }), "ask-1", 1),
        result(answered("Q", { selections: [{ label: "A" }] }), "ask-1", 2),
      ]],
      ["duplicate replay markers", [
        call({ question: "Q", options: [{ label: "A" }] }),
        replay({ ...replayDetails(), question: "Q", context: undefined, answer: { selections: [{ label: "A" }] } }),
        replay({ ...replayDetails(), question: "Q", context: undefined, answer: { selections: [{ label: "A" }] } }),
      ]],
      ["invalid call arguments", [
        call({ question: " " }),
        result(answered("Q", { selections: [] })),
      ]],
    ] as const;

    for (const [_label, messages] of cases) {
      const snapshot = structuredClone(messages);
      expect(rewrite(messages as any)).toEqual(messages);
      expect(messages).toEqual(snapshot);
    }
  });

  it("replaces a replay marker with a summary and enriches selected descriptions", () => {
    const messages = [
      call({
        question: "  Choose  ",
        context: "  Release  ",
        options: [{ label: "  B  ", description: "  Second  " }],
      }),
      replay(replayDetails(), 1_234),
    ];
    const snapshot = structuredClone(messages);

    expect(rewrite(messages)).toEqual([
      summary(payload("Choose", "single", [{ label: "B", description: "Second" }], "Release"), 1_234),
    ]);
    expect(messages).toEqual(snapshot);
  });

  it("keeps a branch summary after the projected Ask summary", () => {
    const branchSummary = { role: "branchSummary", content: "Earlier branch", timestamp: 50 };
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      branchSummary,
      replay(replayDetails(), 55),
    ];

    expect(rewrite(messages)).toEqual([
      summary(payload("Choose", "single", [{ label: "B" }], "Release"), 55),
      branchSummary,
    ]);
  });

  it("projects an empty submitted replay as an empty answer", () => {
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      replay(replayDetails({ answer: { selections: [] } }), 99),
    ];

    expect(rewrite(messages)).toEqual([
      summary(payload("Choose", "single", [], "Release"), 99),
    ]);
  });

  it("retains replay comments and canonical freeform", () => {
    const answer = {
      selections: [{ label: "A", comment: "because" }, { label: "B" }],
      freeform: "extra",
    };
    const messages = [
      call({
        question: "Choose",
        context: "Release",
        options: [{ label: "A", description: "First" }, { label: "B" }],
        allowMultiple: true,
      }),
      replay(replayDetails({ allowMultiple: true, answer }), 44),
    ];

    expect(rewrite(messages)).toEqual([
      summary(payload("Choose", "multi", [
        { label: "A", description: "First", comment: "because" },
        { label: "B" },
      ], "Release", "extra"), 44),
    ]);
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
    ["malformed replay details", [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      replay(replayDetails({ answer: { selections: "B" } })),
    ]],
    ["unmatched replay", [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      replay(replayDetails({ toolCallId: "missing" })),
    ]],
    ["wrong-role replay", [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      { ...replay(replayDetails()), role: "user" },
    ]],
  ] as const)("leaves an ambiguous, malformed, or impossible replay unchanged: %s", (_label, messages) => {
    expect(rewrite(messages as any)).toEqual(messages);
  });

  it("uses a revised replay answer instead of the native result", () => {
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "A" }, { label: "B", description: "Second" }] }),
      result(answered("Choose", { selections: [{ label: "A" }] }), "ask-1", 700),
      replay(replayDetails(), 800),
    ];

    expect(rewrite(messages)).toEqual([
      summary(payload("Choose", "single", [{ label: "B", description: "Second" }], "Release"), 800),
    ]);
  });

  it.each([
    ["unanswered", result({ status: "unanswered", question: "Choose" })],
    ["cancelled", result({ status: "cancelled", question: "Choose" })],
    ["UI unavailable", result({ status: "ui_unavailable", question: "Choose" })],
    ["errored", { ...result(answered("Choose", { selections: [{ label: "A" }] })), isError: true }],
    ["malformed details", result(answered("Choose", { selections: "A" }))],
  ])("uses a valid replay over a %s native result", (_label, nativeResult) => {
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "A" }, { label: "B", description: "Second" }] }),
      nativeResult,
      replay(replayDetails(), 800),
    ];

    expect(rewrite(messages)).toEqual([
      summary(payload("Choose", "single", [{ label: "B", description: "Second" }], "Release"), 800),
    ]);
  });
});
