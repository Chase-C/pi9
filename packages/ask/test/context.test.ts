import { describe, expect, it } from "vitest";

import { rewriteAskContext } from "../src/session.js";

const rewrite = (messages: readonly unknown[]) => rewriteAskContext(messages as never);
const call = (args: unknown, id = "ask-1") => ({
  role: "assistant",
  content: [{ type: "text", text: "before" }, { type: "toolCall", id, name: "ask", arguments: args }],
  timestamp: 100,
});
const result = (answer: unknown, id = "ask-1", timestamp = 200, overrides: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "ask",
  content: [{ type: "text", text: "the original verbose result" }],
  details: { status: "answered", answer },
  isError: false,
  timestamp,
  ...overrides,
});
const replay = (answer: unknown, timestamp = 300, toolCallId = "ask-1") => ({
  role: "custom",
  customType: "ask:reanswer",
  content: "",
  display: false,
  details: { toolCallId, answer },
  timestamp,
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
      }),
      result({
        selections: [{ option: 1, comment: "Safest" }, { option: 2 }],
        freeform: "Ship Friday",
      }, "ask-1", 500),
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

  it("keeps presentation data in the source call and out of stored answers", () => {
    const preview = "CONTEXT_PREVIEW_SENTINEL";
    const messages = [
      call({ question: "Choose", options: [{ label: "A", description: "First", preview }] }),
      result({ selections: [{ option: 0 }] }),
    ];
    const rewritten = rewrite(messages) as any[];

    expect(JSON.stringify(messages[1])).not.toContain(preview);
    expect(JSON.parse(rewritten[0].content).answer).toEqual({
      selections: [{ label: "A", description: "First" }],
    });
    expect(JSON.stringify(rewritten)).not.toContain(preview);
  });

  it("uses single mode and omits absent optional payload fields", () => {
    const rewritten = rewrite([
      call({ question: "Choose", options: [{ label: "A" }, { label: "B" }] }),
      result({ selections: [{ option: 0 }] }, "ask-1", 600),
    ]);
    expect(rewritten).toEqual([
      summary(payload("Choose", "single", [{ label: "A" }]), 600),
    ]);
  });

  it("replaces a replay with a summary and source-owned descriptions", () => {
    const messages = [
      call({
        question: "  Choose  ",
        context: "  Release  ",
        options: [{ label: "  B  ", description: "  Second  " }],
      }),
      replay({ selections: [{ option: 0 }] }, 1_234),
    ];
    const snapshot = structuredClone(messages);

    expect(rewrite(messages)).toEqual([
      summary(payload("Choose", "single", [{ label: "B", description: "Second" }], "Release"), 1_234),
    ]);
    expect(messages).toEqual(snapshot);
  });

  it("uses the revision instead of a native result", () => {
    const rewritten = rewrite([
      call({ question: "Choose", context: "Release", options: [{ label: "A" }, { label: "B", description: "Second" }] }),
      result({ selections: [{ option: 0 }] }, "ask-1", 700),
      replay({ selections: [{ option: 1 }] }, 800),
    ]);

    expect(rewritten).toEqual([
      summary(payload("Choose", "single", [{ label: "B", description: "Second" }], "Release"), 800),
    ]);
  });

  it("keeps a branch summary after the projected Ask summary", () => {
    const branchSummary = { role: "branchSummary", content: "Earlier branch", timestamp: 50 };
    const messages = [
      call({ question: "Choose", context: "Release", options: [{ label: "B" }] }),
      branchSummary,
      replay({ selections: [{ option: 0 }] }, 55),
    ];

    expect(rewrite(messages)).toEqual([
      summary(payload("Choose", "single", [{ label: "B" }], "Release"), 55),
      branchSummary,
    ]);
  });

  it("projects empty, commented, and freeform answers", () => {
    expect(rewrite([
      call({ question: "Choose", options: [{ label: "A" }] }),
      replay({ selections: [] }, 1),
    ])).toEqual([summary(payload("Choose", "single", []), 1)]);

    expect(rewrite([
      call({
        question: "Choose",
        options: [{ label: "A", description: "First" }, { label: "B" }],
        allowMultiple: true,
      }),
      replay({ selections: [{ option: 0, comment: "because" }, { option: 1 }], freeform: "extra" }, 2),
    ])).toEqual([summary(payload("Choose", "multi", [
      { label: "A", description: "First", comment: "because" },
      { label: "B" },
    ], undefined, "extra"), 2)]);
  });

  it("leaves incomplete, failed, malformed, and non-standalone native asks unchanged", () => {
    const validCall = call({ question: "Q", options: [{ label: "A" }] });
    const cases = [
      [validCall],
      [validCall, { ...result({ selections: [{ option: 0 }] }), details: { status: "cancelled" } }],
      [validCall, result({ selections: [{ option: 0 }] }, "ask-1", 2, { isError: true })],
      [validCall, { ...result({ selections: [] }), details: { status: "answered", answer: { selections: "A" } } }],
      [validCall, result({ selections: [{ option: 0 }] }, "different")],
      [call({ question: " " }), result({ selections: [] })],
      [
        call({ question: "Q", options: [{ label: "A" }] }),
        call({ question: "Q", options: [{ label: "A" }] }),
        replay({ selections: [{ option: 0 }] }),
      ],
      [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "ask-1", name: "ask", arguments: { question: "Q", options: [{ label: "A" }] } },
            { type: "toolCall", id: "read-1", name: "read", arguments: {} },
          ],
        },
        result({ selections: [{ option: 0 }] }),
      ],
      [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "ask-1", name: "ask", arguments: { question: "Q", options: [{ label: "A" }] } },
            { type: "toolCall", id: "ask-2", name: "ask", arguments: { question: "Other", options: [{ label: "B" }] } },
          ],
        },
        result({ selections: [{ option: 0 }] }),
      ],
      [validCall, result({ selections: [{ option: 0 }] }, "ask-1", 1), result({ selections: [{ option: 0 }] }, "ask-1", 2)],
    ];

    for (const messages of cases) {
      const snapshot = structuredClone(messages);
      expect(rewrite(messages)).toEqual(messages);
      expect(messages).toEqual(snapshot);
    }
  });

  it("leaves ambiguous or impossible replay records unchanged", () => {
    const cases = [
      [
        call({ question: "Choose", options: [{ label: "A" }] }),
        replay({ selections: [{ option: 0 }] }),
        replay({ selections: [{ option: 0 }] }),
      ],
      [
        call({ question: "Choose", options: [{ label: "A" }] }),
        replay({ selections: [{ option: 1 }] }),
      ],
      [
        call({ question: "Choose", options: [{ label: "A" }, { label: "B" }] }),
        replay({ selections: [{ option: 0 }, { option: 1 }] }),
      ],
      [
        call({ question: "Choose", options: [{ label: "A" }], allowMultiple: true }),
        replay({ selections: [{ option: 0 }, { option: 0 }] }),
      ],
      [
        call({ question: "Choose", options: [{ label: "A" }], allowFreeform: false }),
        replay({ selections: [], freeform: "extra" }),
      ],
      [
        call({ question: "Choose", options: [{ label: "A" }] }),
        replay({ selections: "A" }),
      ],
      [
        call({ question: "Choose", options: [{ label: "A" }] }),
        replay({ selections: [{ option: 0 }] }, 300, "missing"),
      ],
      [
        call({ question: "Choose", options: [{ label: "A" }] }),
        { ...replay({ selections: [{ option: 0 }] }), role: "user" },
      ],
    ];

    for (const messages of cases) expect(rewrite(messages as any)).toEqual(messages);
  });

  it.each([
    ["unanswered", { status: "unanswered" }],
    ["cancelled", { status: "cancelled" }],
    ["UI unavailable", { status: "ui_unavailable" }],
    ["errored", { status: "answered", answer: { selections: [{ option: 0 }] } }],
    ["malformed", { status: "answered", answer: { selections: "A" } }],
  ])("uses a valid replay over a %s native result", (_label, details) => {
    const native = {
      ...result({ selections: [{ option: 0 }] }),
      details,
      ...(_label === "errored" ? { isError: true } : {}),
    };
    const rewritten = rewrite([
      call({ question: "Choose", options: [{ label: "A" }, { label: "B" }] }),
      native,
      replay({ selections: [{ option: 1 }] }, 800),
    ]) as any[];

    expect(JSON.parse(rewritten[0].content).answer).toEqual({ selections: [{ label: "B" }] });
  });
});
