import { describe, expect, it } from "vitest";
import {
  createQuestionnaireState,
  transitionQuestionnaire,
} from "../src/state.js";

const config = {
  options: [{ label: "TypeScript" }, { label: "Rust" }],
  allowMultiple: true,
  allowFreeform: true,
};

describe("questionnaire state", () => {
  it("tracks highlighted rows and toggles checked options in multi-select", () => {
    let state = createQuestionnaireState(config);
    expect(state.highlightedRow).toBe(0);
    state = transitionQuestionnaire(state, { type: "move", delta: 1 });
    state = transitionQuestionnaire(state, { type: "toggle" });
    expect([...state.checked]).toEqual(["Rust"]);
    expect(state.mode).toBe("select");
  });

  it("single-select finalizes the highlighted option", () => {
    let state = createQuestionnaireState({ ...config, allowMultiple: false });
    state = transitionQuestionnaire(state, { type: "move", delta: 1 });
    state = transitionQuestionnaire(state, { type: "toggle" });
    expect(state.answer).toEqual({ selections: [{ label: "Rust" }] });
  });

  it("opens a comment without selecting and saves trimmed comments", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "openComment" });
    expect(state.mode).toBe("comment");
    expect(state.checked.size).toBe(0);
    state = transitionQuestionnaire(state, { type: "edit", value: "  safer types  " });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.comments.get("TypeScript")).toBe("safer types");
    expect(state.mode).toBe("select");
  });

  it("removes a saved comment when an empty edit is saved", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "note" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "   " });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.comments.has("TypeScript")).toBe(false);
  });

  it("Escape rolls editor changes back to the previously saved value", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "saved" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "discard me" });
    state = transitionQuestionnaire(state, { type: "cancelEditor" });
    expect(state.comments.get("TypeScript")).toBe("saved");
    expect(state.editorDraft).toBe("");
    expect(state.mode).toBe("select");
  });

  it("single-select freeform saves and finalizes a trimmed response", () => {
    let state = createQuestionnaireState({ ...config, allowMultiple: false });
    state = transitionQuestionnaire(state, { type: "openFreeform" });
    state = transitionQuestionnaire(state, { type: "edit", value: "  Zig  " });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.freeformDraft).toBe("Zig");
    expect(state.answer).toEqual({ selections: [], freeform: "Zig" });
  });

  it("keeps empty freeform open for single-select questions with options", () => {
    let state = createQuestionnaireState({ ...config, allowMultiple: false });
    state = transitionQuestionnaire(state, { type: "openFreeform" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.answer).toBeNull();
    expect(state.mode).toBe("select");
  });

  it("multi-select freeform saves a draft and combines it on submit", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "toggle" });
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "preferred" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    state = transitionQuestionnaire(state, { type: "openFreeform" });
    state = transitionQuestionnaire(state, { type: "edit", value: "  and Zig  " });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.answer).toBeNull();
    expect(state.freeformDraft).toBe("and Zig");
    expect(state.freeformChecked).toBe(true);
    state = transitionQuestionnaire(state, { type: "submit" });
    expect(state.answer).toEqual({
      selections: [{ label: "TypeScript", comment: "preferred" }],
      freeform: "and Zig",
    });
  });

  it("submits an empty multi-select freeform-only answer from the submit row", () => {
    let state = createQuestionnaireState({ options: [], allowMultiple: true, allowFreeform: true });
    state = transitionQuestionnaire(state, { type: "openFreeform" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.answer).toBeNull();
    state = transitionQuestionnaire(state, { type: "move", delta: 1 });
    state = transitionQuestionnaire(state, { type: "submit" });
    expect(state.answer).toEqual({ selections: [] });
  });

  it("selects saved multi-select freeform text and omits it when unchecked", () => {
    let state = createQuestionnaireState({ options: [], allowMultiple: true, allowFreeform: true });
    state = transitionQuestionnaire(state, { type: "openFreeform" });
    state = transitionQuestionnaire(state, { type: "edit", value: "  and Zig  " });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.answer).toBeNull();
    expect(state.freeformChecked).toBe(true);
    state = transitionQuestionnaire(state, { type: "toggleFreeform" });
    state = transitionQuestionnaire(state, { type: "submit" });
    expect(state.answer).toEqual({ selections: [] });
  });

  it("final answers omit comments belonging to unselected options", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "not selected" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    state = transitionQuestionnaire(state, { type: "move", delta: 1 });
    state = transitionQuestionnaire(state, { type: "toggle" });
    state = transitionQuestionnaire(state, { type: "submit" });
    expect(state.answer).toEqual({ selections: [{ label: "Rust" }] });
  });
});
