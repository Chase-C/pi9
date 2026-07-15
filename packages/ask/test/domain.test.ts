import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  buildAnsweredResponse,
  buildCancelledResponse,
  buildUiUnavailableResponse,
  buildUnansweredResponse,
  formatAskAnswer,
} from "../src/response.js";
import { MAX_TIMEOUT_MS } from "../src/config.js";
import {
  AskAnswerSchema,
  AskAnsweredDetailsSchema,
  AskParamsSchema,
  AskReplayDetailsSchema,
  AskSelectionSchema,
} from "../src/schema.js";
import type { AskAnswer } from "../src/types.js";
import { validateAskParams } from "../src/validation.js";

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
    selections: [{ label: "Blue", description: "Calm", comment: "Best fit" }],
    freeform: "Ship today",
  };

  it("checks selections, answers, replay details, and answered native details strictly", () => {
    expect(Check(AskSelectionSchema, answer.selections[0])).toBe(true);
    expect(Check(AskAnswerSchema, answer)).toBe(true);
    expect(Check(AskReplayDetailsSchema, {
      toolCallId: "ask-1",
      question: "Which color?",
      allowMultiple: false,
      answer,
    })).toBe(true);
    expect(Check(AskAnsweredDetailsSchema, {
      status: "answered",
      question: "Which color?",
      answer,
    })).toBe(true);

    expect(Check(AskAnswerSchema, { selections: [{ label: "Blue", preview: "hidden" }] })).toBe(false);
    expect(Check(AskReplayDetailsSchema, {
      toolCallId: "ask-1",
      question: "Which color?",
      allowMultiple: false,
      answer,
      unknown: true,
    })).toBe(false);
    expect(Check(AskAnsweredDetailsSchema, { status: "cancelled", question: "Which color?", answer })).toBe(false);
  });
});

describe("validateAskParams", () => {
  it("trims input and applies interaction defaults", () => {
    expect(validateAskParams({
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
    expect(validateAskParams({
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
    expect(() => validateAskParams(params as never)).toThrow(message as string);
  });
});

describe("ask responses", () => {
  const answer: AskAnswer = {
    selections: [{ label: "Blue", description: "Calm", comment: "Best fit" }],
    freeform: "Ship today",
  };

  it("formats and builds a structured answer", () => {
    expect(formatAskAnswer(answer)).toBe("Selected: Blue — Calm (Best fit)\nFreeform: Ship today");
    expect(buildAnsweredResponse("Which color?", answer)).toEqual({
      content: [{ type: "text", text: "Selected: Blue — Calm (Best fit)\nFreeform: Ship today" }],
      details: { status: "answered", question: "Which color?", answer },
    });
  });

  it("builds distinct unanswered, cancellation, and UI-unavailable results", () => {
    expect(buildUnansweredResponse("Continue?")).toMatchObject({
      content: [{ type: "text", text: "The question timed out without an answer." }],
      details: { status: "unanswered", question: "Continue?" },
    });
    expect(buildCancelledResponse("Continue?")).toMatchObject({
      content: [{ type: "text", text: "User cancelled the question." }],
      details: { status: "cancelled", question: "Continue?" },
    });
    expect(buildUiUnavailableResponse("Continue?")).toMatchObject({
      content: [{ type: "text", text: "Interactive UI is unavailable." }],
      details: { status: "ui_unavailable", question: "Continue?" },
    });
  });
});
