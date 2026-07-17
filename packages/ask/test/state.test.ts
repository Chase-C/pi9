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
    expect([...state.checked]).toEqual([1]);
    expect(state.editor.kind).toBe("select");
  });

  it("single-select finalizes the highlighted option", () => {
    let state = createQuestionnaireState({ ...config, allowMultiple: false });
    state = transitionQuestionnaire(state, { type: "move", delta: 1 });
    state = transitionQuestionnaire(state, { type: "toggle" });
    expect(state.answer).toEqual({ selections: [{ option: 1 }] });
  });

  it("omits presentation-only preview content from final selections", () => {
    let state = createQuestionnaireState({
      ...config,
      options: [{ label: "TypeScript", description: "Typed", preview: "  type A = string;\n" }],
      allowMultiple: false,
    });
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "preferred" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    state = transitionQuestionnaire(state, { type: "toggle" });
    expect(state.answer).toEqual({
      selections: [{ option: 0, comment: "preferred" }],
    });
    expect(state.answer?.selections[0]).not.toHaveProperty("preview");
  });

  it("opens a comment without selecting and saves trimmed comments", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "openComment" });
    expect(state.editor.kind).toBe("comment");
    expect(state.checked.size).toBe(0);
    state = transitionQuestionnaire(state, { type: "edit", value: "  safer types  " });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.comments.get(0)).toBe("safer types");
    expect(state.editor.kind).toBe("select");
  });

  it("removes a saved comment when an empty edit is saved", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "note" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "   " });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.comments.has(0)).toBe(false);
  });

  it("Escape rolls editor changes back to the previously saved value", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "saved" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "discard me" });
    state = transitionQuestionnaire(state, { type: "cancelEditor" });
    expect(state.comments.get(0)).toBe("saved");
    expect(state.editor).toEqual({ kind: "select" });
  });

  it("single-select freeform saves and finalizes a trimmed response", () => {
    let state = createQuestionnaireState({ ...config, allowMultiple: false });
    state = transitionQuestionnaire(state, { type: "move", delta: 2 });
    state = transitionQuestionnaire(state, { type: "activate" });
    state = transitionQuestionnaire(state, { type: "edit", value: "  Zig  " });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.freeformDraft).toBe("Zig");
    expect(state.answer).toEqual({ selections: [], freeform: "Zig" });
  });

  it("keeps empty freeform open for single-select questions with options", () => {
    let state = createQuestionnaireState({ ...config, allowMultiple: false });
    state = transitionQuestionnaire(state, { type: "move", delta: 2 });
    state = transitionQuestionnaire(state, { type: "activate" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.answer).toBeNull();
    expect(state.editor.kind).toBe("select");
  });

  it("multi-select freeform saves a draft and combines it on submit", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "toggle" });
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "preferred" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    state = transitionQuestionnaire(state, { type: "move", delta: 2 });
    state = transitionQuestionnaire(state, { type: "activate" });
    state = transitionQuestionnaire(state, { type: "edit", value: "  and Zig  " });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.answer).toBeNull();
    expect(state.freeformDraft).toBe("and Zig");
    expect(state.freeformChecked).toBe(true);
    state = transitionQuestionnaire(state, { type: "submit" });
    expect(state.answer).toEqual({
      selections: [{ option: 0, comment: "preferred" }],
      freeform: "and Zig",
    });
  });

  it("owns canonical row order without retaining options in config", () => {
    const single = createQuestionnaireState({ ...config, allowMultiple: false, allowFreeform: false });
    const multi = createQuestionnaireState({ ...config, allowFreeform: false });
    const freeform = createQuestionnaireState(config);

    expect(single.rows.map(row => row.kind)).toEqual(["option", "option"]);
    expect(multi.rows.map(row => row.kind)).toEqual(["option", "option", "submit"]);
    expect(freeform.rows.map(row => row.kind)).toEqual(["option", "option", "freeform", "submit"]);
    expect(freeform.config).toEqual({ allowMultiple: true, allowFreeform: true });
    expect(freeform.config).not.toHaveProperty("options");
  });

  it("wraps movement over canonical rows", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "move", delta: -1 });
    expect(state.highlightedRow).toBe(3);
    state = transitionQuestionnaire(state, { type: "move", delta: 1 });
    expect(state.highlightedRow).toBe(0);
  });

  it("distinguishes freeform activate from multi-select toggle", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "move", delta: 2 });
    state = transitionQuestionnaire(state, { type: "toggle" });
    expect(state.freeformChecked).toBe(true);
    expect(state.editor.kind).toBe("select");
    state = transitionQuestionnaire(state, { type: "activate" });
    expect(state.editor).toEqual({ kind: "freeform", target: state.rows[2], draft: "" });
  });

  it("activates the submit row", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "move", delta: 3 });
    state = transitionQuestionnaire(state, { type: "toggle" });
    expect(state.answer).toEqual({ selections: [] });
  });

  it("saves comments to their explicit canonical editor target", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "openComment" });
    expect(state.editor).toEqual({ kind: "comment", target: state.rows[0], draft: "" });
    state.highlightedRow = 1;
    state = transitionQuestionnaire(state, { type: "edit", value: "first option" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    expect(state.comments.get(0)).toBe("first option");
    expect(state.comments.has(1)).toBe(false);
  });

  it("rejects construction without an option", () => {
    expect(() => createQuestionnaireState({ ...config, options: [] })).toThrow("at least one option");
  });

  it("final answers omit comments belonging to unselected options", () => {
    let state = createQuestionnaireState(config);
    state = transitionQuestionnaire(state, { type: "openComment" });
    state = transitionQuestionnaire(state, { type: "edit", value: "not selected" });
    state = transitionQuestionnaire(state, { type: "saveEditor" });
    state = transitionQuestionnaire(state, { type: "move", delta: 1 });
    state = transitionQuestionnaire(state, { type: "toggle" });
    state = transitionQuestionnaire(state, { type: "submit" });
    expect(state.answer).toEqual({ selections: [{ option: 1 }] });
  });
});
