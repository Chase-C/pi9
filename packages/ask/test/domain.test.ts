import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  buildAnsweredResponse,
  buildCancelledResponse,
  buildUiUnavailableResponse,
  formatAskAnswer,
} from "../src/response.js";
import { AskParamsSchema } from "../src/schema.js";
import type { AskAnswer } from "../src/types.js";
import { validateAskParams } from "../src/validation.js";

describe("AskParamsSchema", () => {
  it("describes the strict provider-facing parameters", () => {
    expect(Check(AskParamsSchema, {
      question: "Choose",
      context: "A little context",
      options: [{ label: "A", description: "First" }],
      allowMultiple: true,
      allowFreeform: false,
    })).toBe(true);
    expect(Check(AskParamsSchema, { question: "Choose", answered: true })).toBe(true);
    expect(Check(AskParamsSchema, { question: "Choose", unknown: true })).toBe(false);
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

  it.each([
    [{ question: " " }, "question"],
    [{ question: "Choose", options: [{ label: " ", description: "No" }] }, "label"],
    [{ question: "Choose", options: [{ label: "A", description: "1" }, { label: " A ", description: "2" }] }, "duplicate"],
    [{ question: "Choose", allowFreeform: false }, "option"],
    [{ question: "Choose", answered: true }, "reserved"],
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

  it("builds distinct cancellation and UI-unavailable results", () => {
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
