import type { Ask, AskAnswer, AskOption } from "./domain.js";

export type QuestionnaireOptionRow = { kind: "option"; index: number; option: AskOption };
export type QuestionnaireFreeformRow = { kind: "freeform" };
export type QuestionnaireSubmitRow = { kind: "submit" };
export type QuestionnaireRow =
  | QuestionnaireOptionRow
  | QuestionnaireFreeformRow
  | QuestionnaireSubmitRow;

export type QuestionnaireEditor =
  | { kind: "select" }
  | { kind: "comment"; target: QuestionnaireOptionRow; draft: string }
  | { kind: "freeform"; target: QuestionnaireFreeformRow; draft: string };

type QuestionnaireConfig = Pick<Ask, "allowMultiple" | "allowFreeform">;
type QuestionnaireInput = QuestionnaireConfig & Pick<Ask, "options">;

export interface QuestionnaireState {
  config: QuestionnaireConfig;
  rows: readonly QuestionnaireRow[];
  highlightedRow: number;
  checked: Set<number>;
  comments: Map<number, string>;
  freeformDraft: string;
  freeformChecked: boolean;
  editor: QuestionnaireEditor;
  answer: AskAnswer | null;
}

export type QuestionnaireEvent =
  | { type: "move"; delta: number }
  | { type: "activate" }
  | { type: "toggle" }
  | { type: "openComment" }
  | { type: "edit"; value: string }
  | { type: "saveEditor" }
  | { type: "cancelEditor" }
  | { type: "submit" };

export function createQuestionnaireState(input: QuestionnaireInput): QuestionnaireState {
  if (input.options.length === 0) throw new Error("Questionnaire requires at least one option");

  return {
    config: {
      allowMultiple: input.allowMultiple,
      allowFreeform: input.allowFreeform,
    },
    rows: createRows(input),
    highlightedRow: 0,
    checked: new Set(),
    comments: new Map(),
    freeformDraft: "",
    freeformChecked: false,
    editor: { kind: "select" },
    answer: null,
  };
}

export function transitionQuestionnaire(state: QuestionnaireState, event: QuestionnaireEvent): QuestionnaireState {
  if (state.answer) return state;
  const next = clone(state);

  switch (event.type) {
    case "move":
      if (next.editor.kind === "select") {
        next.highlightedRow = wrapRow(next.highlightedRow + event.delta, next.rows.length);
      }
      break;
    case "activate":
      if (next.editor.kind === "select") activateRow(next);
      break;
    case "toggle":
      if (next.editor.kind === "select") toggleRow(next);
      break;
    case "openComment": {
      if (next.editor.kind !== "select") break;
      const row = currentRow(next);
      if (row.kind !== "option") break;
      next.editor = {
        kind: "comment",
        target: row,
        draft: next.comments.get(row.index) ?? "",
      };
      break;
    }
    case "edit":
      if (next.editor.kind !== "select") next.editor = { ...next.editor, draft: event.value };
      break;
    case "saveEditor": {
      if (next.editor.kind === "select") break;
      const editor = next.editor;
      const saved = editor.draft.trim();
      if (editor.kind === "comment") {
        const option = editor.target.index;
        if (saved) next.comments.set(option, saved);
        else next.comments.delete(option);
      } else {
        next.freeformDraft = saved;
        if (next.config.allowMultiple) next.freeformChecked = saved.length > 0;
      }
      next.editor = { kind: "select" };
      if (editor.kind === "freeform" && !next.config.allowMultiple && saved) {
        next.answer = finalAnswer(next);
      }
      break;
    }
    case "cancelEditor":
      if (next.editor.kind !== "select") next.editor = { kind: "select" };
      break;
    case "submit":
      next.answer = finalAnswer(next);
      break;
  }
  return next;
}

function createRows(input: QuestionnaireInput): QuestionnaireRow[] {
  return [
    ...input.options.map((option, index): QuestionnaireOptionRow => ({ kind: "option", index, option })),
    ...(input.allowFreeform ? [{ kind: "freeform" } as const] : []),
    ...(input.allowMultiple ? [{ kind: "submit" } as const] : []),
  ];
}

function currentRow(state: QuestionnaireState): QuestionnaireRow {
  return state.rows[state.highlightedRow]!;
}

function activateRow(state: QuestionnaireState): void {
  const row = currentRow(state);
  switch (row.kind) {
    case "option":
      toggleOption(state, row.index);
      break;
    case "freeform":
      openFreeform(state, row);
      break;
    case "submit":
      state.answer = finalAnswer(state);
      break;
  }
}

function toggleRow(state: QuestionnaireState): void {
  const row = currentRow(state);
  switch (row.kind) {
    case "option":
      toggleOption(state, row.index);
      break;
    case "freeform":
      if (state.config.allowMultiple) state.freeformChecked = !state.freeformChecked;
      else openFreeform(state, row);
      break;
    case "submit":
      state.answer = finalAnswer(state);
      break;
  }
}

function toggleOption(state: QuestionnaireState, option: number): void {
  if (!state.config.allowMultiple) {
    state.checked = new Set([option]);
    state.answer = finalAnswer(state);
  } else if (state.checked.has(option)) {
    state.checked.delete(option);
  } else {
    state.checked.add(option);
  }
}

function openFreeform(state: QuestionnaireState, target: QuestionnaireFreeformRow): void {
  state.editor = { kind: "freeform", target, draft: state.freeformDraft };
}

function finalAnswer(state: QuestionnaireState): AskAnswer {
  const selections = state.rows.flatMap((row) => {
    if (row.kind !== "option" || !state.checked.has(row.index)) return [];
    const comment = state.comments.get(row.index);
    return [{ option: row.index, ...(comment ? { comment } : {}) }];
  });
  const freeform = state.config.allowMultiple && !state.freeformChecked ? "" : state.freeformDraft.trim();
  return {
    selections,
    ...(freeform ? { freeform } : {}),
  };
}

function wrapRow(row: number, rowCount: number): number {
  return ((row % rowCount) + rowCount) % rowCount;
}

function clone(state: QuestionnaireState): QuestionnaireState {
  return {
    ...state,
    checked: new Set(state.checked),
    comments: new Map(state.comments),
  };
}
