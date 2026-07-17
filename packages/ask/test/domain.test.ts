import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import { MAX_TIMEOUT_MS } from "../src/deadline.js";
import {
  AskAnswerSchema,
  AskAnsweredDetailsSchema,
  AskParamsSchema,
  AskReplayDetailsSchema,
  AskSelectionSchema,
  buildAskResponse,
  formatAskAnswer,
  normalizeAsk,
  type AskAnswer,
} from "../src/domain.js";

const ask = normalizeAsk({
  question: "Which color?",
  options: [{ label: "Blue", description: "Calm" }],
});

describe("AskParamsSchema", () => {
  it("describes the strict provider-facing parameters", () => {
    expect(Check(AskParamsSchema, {
      question: "Choose",
      context: "A little context",
      options: [{ label: "A", description: "First", preview: "  const a = 1;\n" }],
      allowMultiple: true,
      allowFreeform: false,
      timeout: 2500,
    })).toBe(true);
    expect(Check(AskParamsSchema, { question: "Choose" })).toBe(false);
    expect(Check(AskParamsSchema, { question: "Choose", answered: true })).toBe(false);
    expect(Check(AskParamsSchema, { question: "Choose", unknown: true })).toBe(false);
    expect(Check(AskParamsSchema, { question: "Choose", options: [], timeout: 0 })).toBe(false);
    expect(Check(AskParamsSchema, { question: "Choose", options: [{ label: "A" }], timeout: -1 })).toBe(false);
    expect(Check(AskParamsSchema, { question: "Choose", options: [{ label: "A" }], timeout: 1.5 })).toBe(false);
    expect(Check(AskParamsSchema, { question: "Choose", options: [{ label: "A" }], timeout: 0 })).toBe(true);
    expect(Check(AskParamsSchema, { question: "Choose", options: [{ label: "A" }], timeout: MAX_TIMEOUT_MS })).toBe(true);
    expect(Check(AskParamsSchema, { question: "Choose", options: [{ label: "A" }], timeout: MAX_TIMEOUT_MS + 1 })).toBe(false);
    expect(Check(AskParamsSchema, { question: "Choose", options: [{ label: "A", unknown: true }] })).toBe(false);
  });
});

describe("canonical stored-data schemas", () => {
  const answer = {
    selections: [{ option: 0, comment: "Best fit" }],
    freeform: "Ship today",
  };

  it("stores only option references and user-authored answer data", () => {
    expect(Check(AskSelectionSchema, answer.selections[0])).toBe(true);
    expect(Check(AskAnswerSchema, answer)).toBe(true);
    expect(Check(AskReplayDetailsSchema, { toolCallId: "ask-1", answer })).toBe(true);
    expect(Check(AskAnsweredDetailsSchema, { status: "answered", answer })).toBe(true);

    expect(Check(AskAnswerSchema, { selections: [{ option: 0, label: "Blue" }] })).toBe(false);
    expect(Check(AskReplayDetailsSchema, { toolCallId: "ask-1", answer, question: "Which color?" })).toBe(false);
    expect(Check(AskAnsweredDetailsSchema, { status: "cancelled", answer })).toBe(false);
  });
});

describe("normalizeAsk", () => {
  it("trims input and applies interaction defaults", () => {
    expect(normalizeAsk({
      question: "  Which?  ",
      context: "  Helpful  ",
      options: [{ label: " A ", description: " First " }],
    })).toEqual({
      question: "Which?",
      context: "Helpful",
      options: [{ label: "A", description: "First" }],
      allowMultiple: false,
      allowFreeform: true,
    });
  });

  it("preserves non-whitespace preview content and removes whitespace-only previews", () => {
    expect(normalizeAsk({
      question: "Preview?",
      options: [
        { label: "Keep", preview: "\n  indented text  \n" },
        { label: "Drop", preview: " \n\t " },
      ],
      timeout: 0,
    })).toEqual({
      question: "Preview?",
      options: [
        { label: "Keep", preview: "\n  indented text  \n" },
        { label: "Drop" },
      ],
      allowMultiple: false,
      allowFreeform: true,
      timeout: 0,
    });
  });

  it.each([
    [{ question: " " }, "question"],
    [{ question: "Choose", options: [{ label: " ", description: "No" }] }, "label"],
    [{ question: "Choose", options: [{ label: "A", description: "1" }, { label: " A ", description: "2" }] }, "duplicate"],
    [{ question: "Choose", options: [] }, "option"],
  ])("rejects invalid parameters %#", (params, message) => {
    expect(() => normalizeAsk(params as never)).toThrow(message as string);
  });
});

describe("ask responses", () => {
  const answer: AskAnswer = {
    selections: [{ option: 0, comment: "Best fit" }],
    freeform: "Ship today",
  };

  it("formats an answer from its canonical Ask options", () => {
    expect(formatAskAnswer(ask, answer)).toBe("Selected: Blue — Calm (Best fit)\nFreeform: Ship today");
    expect(buildAskResponse(ask, { status: "answered", answer })).toEqual({
      content: [{ type: "text", text: "Selected: Blue — Calm (Best fit)\nFreeform: Ship today" }],
      details: { status: "answered", answer },
    });
  });

  it("builds distinct unanswered, cancellation, and UI-unavailable results", () => {
    expect(buildAskResponse(ask, { status: "unanswered" })).toMatchObject({
      content: [{ type: "text", text: "The question timed out without an answer." }],
      details: { status: "unanswered" },
    });
    expect(buildAskResponse(ask, { status: "cancelled" })).toMatchObject({
      content: [{ type: "text", text: "User cancelled the question." }],
      details: { status: "cancelled" },
    });
    expect(buildAskResponse(ask, { status: "ui_unavailable" })).toMatchObject({
      content: [{ type: "text", text: "Interactive UI is unavailable." }],
      details: { status: "ui_unavailable" },
    });
  });
});
