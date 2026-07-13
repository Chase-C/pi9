type SelectionMode = "single" | "multi";
type QuestionnaireMode = "select" | "comment" | "freeform";

interface QuestionnaireOption {
  id: string;
  label: string;
}

interface QuestionnaireConfig {
  selection: SelectionMode;
  options: readonly QuestionnaireOption[];
  allowFreeform?: boolean;
}

interface AnswerSelection extends QuestionnaireOption {
  comment?: string;
}

interface QuestionnaireAnswer {
  selections: AnswerSelection[];
  freeform?: string;
}

export interface QuestionnaireState {
  config: QuestionnaireConfig;
  highlightedRow: number;
  checked: Set<string>;
  comments: Map<string, string>;
  freeformDraft: string;
  mode: QuestionnaireMode;
  editorDraft: string;
  editorOriginal: string;
  editingOptionId: string | null;
  answer: QuestionnaireAnswer | null;
}

type QuestionnaireEvent =
  | { type: "move"; delta: number }
  | { type: "toggle" }
  | { type: "openComment" }
  | { type: "openFreeform" }
  | { type: "edit"; value: string }
  | { type: "saveEditor" }
  | { type: "cancelEditor" }
  | { type: "submit" };

export function createQuestionnaireState(config: QuestionnaireConfig): QuestionnaireState {
  const ids = new Set<string>();
  for (const option of config.options) {
    if (!option.id) throw new Error("Option ids must be non-empty.");
    if (ids.has(option.id)) throw new Error(`Duplicate option id: ${option.id}.`);
    ids.add(option.id);
  }
  if (config.options.length === 0 && config.allowFreeform === false) {
    throw new Error("A questionnaire needs an option or freeform input.");
  }
  return {
    config: { ...config, options: config.options.map((option) => ({ ...option })) },
    highlightedRow: 0,
    checked: new Set(),
    comments: new Map(),
    freeformDraft: "",
    mode: "select",
    editorDraft: "",
    editorOriginal: "",
    editingOptionId: null,
    answer: null,
  };
}

export function transitionQuestionnaire(state: QuestionnaireState, event: QuestionnaireEvent): QuestionnaireState {
  const next = clone(state);
  if (next.answer) return next;

  switch (event.type) {
    case "move": {
      if (next.mode !== "select") break;
      const rows = next.config.options.length + (next.config.allowFreeform === false ? 0 : 1);
      if (rows > 0) next.highlightedRow = ((next.highlightedRow + event.delta) % rows + rows) % rows;
      break;
    }
    case "toggle": {
      if (next.mode !== "select") break;
      const option = next.config.options[next.highlightedRow];
      if (!option) return openFreeform(next);
      if (next.config.selection === "single") {
        next.checked = new Set([option.id]);
        next.answer = finalAnswer(next);
      } else if (next.checked.has(option.id)) {
        next.checked.delete(option.id);
      } else {
        next.checked.add(option.id);
      }
      break;
    }
    case "openComment": {
      if (next.mode !== "select") break;
      const option = next.config.options[next.highlightedRow];
      if (!option) break;
      next.mode = "comment";
      next.editingOptionId = option.id;
      next.editorOriginal = next.comments.get(option.id) ?? "";
      next.editorDraft = next.editorOriginal;
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
      if (next.mode === "comment" && next.editingOptionId) {
        if (saved) next.comments.set(next.editingOptionId, saved);
        else next.comments.delete(next.editingOptionId);
      } else if (next.mode === "freeform") {
        next.freeformDraft = saved;
      }
      leaveEditor(next);
      const freeformOnly = next.config.options.length === 0;
      if (state.mode === "freeform" && (freeformOnly || (next.config.selection === "single" && saved))) {
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

function finalAnswer(state: QuestionnaireState): QuestionnaireAnswer {
  const selections = state.config.options
    .filter((option) => state.checked.has(option.id))
    .map((option): AnswerSelection => {
      const comment = state.comments.get(option.id);
      return comment ? { ...option, comment } : { ...option };
    });
  const freeform = state.freeformDraft.trim();
  return {
    selections,
    ...(freeform ? { freeform } : {}),
  };
}

function openFreeform(state: QuestionnaireState): QuestionnaireState {
  if (state.mode !== "select" || state.config.allowFreeform === false) return state;
  state.mode = "freeform";
  state.editingOptionId = null;
  state.editorOriginal = state.freeformDraft;
  state.editorDraft = state.freeformDraft;
  return state;
}

function leaveEditor(state: QuestionnaireState): void {
  state.mode = "select";
  state.editorDraft = "";
  state.editorOriginal = "";
  state.editingOptionId = null;
}

function clone(state: QuestionnaireState): QuestionnaireState {
  return {
    ...state,
    config: { ...state.config, options: state.config.options.map((option) => ({ ...option })) },
    checked: new Set(state.checked),
    comments: new Map(state.comments),
    answer: state.answer ? {
      ...state.answer,
      selections: state.answer.selections.map((selection) => ({ ...selection })),
    } : null,
  };
}
