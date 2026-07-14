import type { AskAnswer, ValidatedAskParams } from "./types.js";

type QuestionnaireMode = "select" | "comment" | "freeform";
type QuestionnaireConfig = Pick<ValidatedAskParams, "options" | "allowMultiple" | "allowFreeform">;

export interface QuestionnaireState {
  config: QuestionnaireConfig;
  highlightedRow: number;
  checked: Set<string>;
  comments: Map<string, string>;
  freeformDraft: string;
  freeformChecked: boolean;
  mode: QuestionnaireMode;
  editorDraft: string;
  answer: AskAnswer | null;
}

type QuestionnaireEvent =
  | { type: "move"; delta: number }
  | { type: "toggle" }
  | { type: "toggleFreeform" }
  | { type: "openComment" }
  | { type: "openFreeform" }
  | { type: "edit"; value: string }
  | { type: "saveEditor" }
  | { type: "cancelEditor" }
  | { type: "submit" };

export function createQuestionnaireState(config: QuestionnaireConfig): QuestionnaireState {
  return {
    config,
    highlightedRow: 0,
    checked: new Set(),
    comments: new Map(),
    freeformDraft: "",
    freeformChecked: false,
    mode: "select",
    editorDraft: "",
    answer: null,
  };
}

export function transitionQuestionnaire(state: QuestionnaireState, event: QuestionnaireEvent): QuestionnaireState {
  if (state.answer) return state;
  const next = clone(state);

  switch (event.type) {
    case "move": {
      if (next.mode !== "select") break;
      const rows = next.config.options.length
        + (next.config.allowFreeform ? 1 : 0)
        + (next.config.allowMultiple ? 1 : 0);
      if (rows > 0) next.highlightedRow = ((next.highlightedRow + event.delta) % rows + rows) % rows;
      break;
    }
    case "toggle": {
      if (next.mode !== "select") break;
      const option = next.config.options[next.highlightedRow];
      if (!option) {
        if (next.highlightedRow === next.config.options.length) return openFreeform(next);
        break;
      }
      if (!next.config.allowMultiple) {
        next.checked = new Set([option.label]);
        next.answer = finalAnswer(next);
      } else if (next.checked.has(option.label)) {
        next.checked.delete(option.label);
      } else {
        next.checked.add(option.label);
      }
      break;
    }
    case "toggleFreeform":
      if (next.mode === "select" && next.config.allowMultiple && next.config.allowFreeform) {
        next.freeformChecked = !next.freeformChecked;
      }
      break;
    case "openComment": {
      if (next.mode !== "select") break;
      const option = next.config.options[next.highlightedRow];
      if (!option) break;
      next.mode = "comment";
      next.editorDraft = next.comments.get(option.label) ?? "";
      break;
    }
    case "openFreeform":
      return openFreeform(next);
    case "edit":
      if (next.mode !== "select") next.editorDraft = event.value;
      break;
    case "saveEditor": {
      if (next.mode === "select") break;
      const saved = next.editorDraft.trim();
      if (next.mode === "comment") {
        const option = next.config.options[next.highlightedRow];
        if (option && saved) next.comments.set(option.label, saved);
        else if (option) next.comments.delete(option.label);
      } else if (next.mode === "freeform") {
        next.freeformDraft = saved;
        if (next.config.allowMultiple) next.freeformChecked = saved.length > 0;
      }
      leaveEditor(next);
      const freeformOnly = next.config.options.length === 0;
      if (state.mode === "freeform" && !next.config.allowMultiple && (freeformOnly || saved)) {
        next.answer = finalAnswer(next);
      }
      break;
    }
    case "cancelEditor":
      if (next.mode !== "select") leaveEditor(next);
      break;
    case "submit":
      next.answer = finalAnswer(next);
      break;
  }
  return next;
}

function finalAnswer(state: QuestionnaireState): AskAnswer {
  const selections = state.config.options
    .filter((option) => state.checked.has(option.label))
    .map((option) => {
      const comment = state.comments.get(option.label);
      return comment ? { ...option, comment } : { ...option };
    });
  const freeform = state.config.allowMultiple && !state.freeformChecked ? "" : state.freeformDraft.trim();
  return {
    selections,
    ...(freeform ? { freeform } : {}),
  };
}

function openFreeform(state: QuestionnaireState): QuestionnaireState {
  if (state.mode !== "select" || !state.config.allowFreeform) return state;
  state.mode = "freeform";
  state.editorDraft = state.freeformDraft;
  return state;
}

function leaveEditor(state: QuestionnaireState): void {
  state.mode = "select";
  state.editorDraft = "";
}

function clone(state: QuestionnaireState): QuestionnaireState {
  return {
    ...state,
    checked: new Set(state.checked),
    comments: new Map(state.comments),
  };
}
