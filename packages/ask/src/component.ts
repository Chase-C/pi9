import {
  Editor,
  Key,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import {
  createQuestionnaireState,
  transitionQuestionnaire,
  type QuestionnaireState,
} from "./state.js";
import type { AskAnswer, AskOption } from "./types.js";

type NormalizedOption = AskOption & { id: string };

interface AskComponentOptions {
  tui: TUI;
  theme: Theme;
  question: string;
  context?: string;
  options?: readonly (AskOption & { id?: string })[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  onSubmit?: (answer: AskAnswer) => void;
  onCancel?: () => void;
}

export class AskComponent implements Component, Focusable {
  private readonly sourceOptions: NormalizedOption[];
  private readonly optionsById = new Map<string, NormalizedOption>();
  private readonly editor: Editor;
  private questionnaireState: QuestionnaireState;
  private completedAnswer: AskAnswer | null = null;
  private cancelled = false;
  private _focused = false;

  constructor(private readonly config: AskComponentOptions) {
    if (!config.question.trim()) throw new Error("An ask question must be non-empty.");

    this.sourceOptions = (config.options ?? []).map((option, index) => {
      const id = option.id || `option-${index + 1}`;
      const normalized = { ...option, id };
      this.optionsById.set(id, normalized);
      return normalized;
    });

    this.questionnaireState = createQuestionnaireState({
      selection: config.allowMultiple ? "multi" : "single",
      options: this.sourceOptions.map(({ id, label }) => ({ id, label })),
      allowFreeform: config.allowFreeform !== false,
    });

    this.editor = new Editor(config.tui, editorTheme(config.theme));
    this.editor.onChange = (value) => {
      if (this.questionnaireState.mode === "select") return;
      this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "edit", value }));
    };
    this.editor.onSubmit = (value) => {
      if (this.questionnaireState.mode === "select") return;
      const next = transitionQuestionnaire(
        transitionQuestionnaire(this.questionnaireState, { type: "edit", value }),
        { type: "saveEditor" },
      );
      this.applyState(next);
      if (next.mode === "select") this.editor.setText("");
      this.finishIfAnswered(next);
      this.requestRender();
    };
  }

  /** Current questionnaire state, useful to UI integrators. */
  get state(): QuestionnaireState {
    return this.questionnaireState;
  }

  /** The answer after a successful submit, or null while the prompt is open. */
  get answer(): AskAnswer | null {
    return this.completedAnswer;
  }

  /** Whether the component was cancelled. */
  get isCancelled(): boolean {
    return this.cancelled;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.questionnaireState.mode !== "select";
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this.completedAnswer || this.cancelled) return;

    if (this.questionnaireState.mode !== "select") {
      // Escape is intentionally an editor operation: it discards the draft,
      // while Ctrl+C remains the conventional way to cancel the whole ask.
      if (matchesKey(data, Key.escape)) {
        const original = this.questionnaireState.editorOriginal;
        this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "cancelEditor" }));
        this.editor.setText(original);
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.ctrl("c"))) {
        this.cancel();
        return;
      }
      this.editor.handleInput(data);
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.up) || isLiteral(data, "k")) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || isLiteral(data, "j")) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.move(-5);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.move(5);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.move(-this.questionnaireState.highlightedRow);
      return;
    }
    if (matchesKey(data, Key.end)) {
      const rowCount = this.rowCount();
      this.move(rowCount - 1 - this.questionnaireState.highlightedRow);
      return;
    }

    if (isLiteral(data, "c")) {
      this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "openComment" }));
      return;
    }

    if (matchesKey(data, Key.space)) {
      if (this.isFreeformRow()) {
        this.openFreeform();
      } else {
        this.toggle();
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.isFreeformRow()) {
        this.openFreeform();
      } else if (this.questionnaireState.config.selection === "single") {
        this.toggle();
      } else {
        this.submit();
      }
    }
  }

  render(width: number): string[] {
    const renderWidth = safeWidth(width);
    const lines: string[] = [];
    const add = (line: string) => lines.push(fit(line, renderWidth));
    const addPrefixed = (prefix: string, text: string, color?: "text" | "muted" | "dim" | "accent") => {
      const styled = color ? this.config.theme.fg(color, text) : text;
      addWrappedWithPrefix(lines, prefix, styled, renderWidth);
    };

    add(this.config.theme.fg("border", "─".repeat(renderWidth)));

    if (this.config.context?.trim()) {
      addPrefixed(" ", this.config.context, "muted");
      add("");
    }
    addPrefixed(" ", this.config.theme.bold(this.config.question), "text");
    add("");

    if (this.questionnaireState.mode === "select") {
      this.renderOptions(lines, renderWidth);
      add("");
      addPrefixed(" ", this.config.theme.fg("dim", this.helpText()), "dim");
    } else {
      // Keep the options visible while editing so the comment remains tied to
      // the option it belongs to, and so freeform editing does not feel like a
      // separate prompt.
      this.renderOptions(lines, renderWidth);
      add("");
      const option = this.editingOption();
      const title = this.questionnaireState.mode === "comment"
        ? `Comment for ${option?.label ?? "option"}`
        : "Your response";
      addPrefixed(" ", this.config.theme.bold(title), "accent");
      for (const line of this.editor.render(renderWidth)) add(fit(line, renderWidth));
      addPrefixed(" ", this.config.theme.fg("dim", this.editorHelpText()), "dim");
    }

    add(this.config.theme.fg("border", "─".repeat(renderWidth)));
    return lines;
  }

  /** Submit the current multi-select answer programmatically. */
  submit(): void {
    if (this.completedAnswer || this.cancelled) return;
    const next = transitionQuestionnaire(this.questionnaireState, { type: "submit" });
    this.applyState(next);
    this.finishIfAnswered(next);
    this.requestRender();
  }

  /** Cancel the ask, invoking onCancel at most once. */
  cancel(): void {
    if (this.completedAnswer || this.cancelled) return;
    this.cancelled = true;
    this.editor.focused = false;
    this.config.onCancel?.();
  }

  private renderOptions(lines: string[], width: number): void {
    const add = (line: string) => lines.push(fit(line, width));
    const addPrefixed = (prefix: string, text: string, color?: "text" | "muted" | "dim" | "accent") => {
      const styled = color ? this.config.theme.fg(color, text) : text;
      addWrappedWithPrefix(lines, prefix, styled, width);
    };

    for (let index = 0; index < this.sourceOptions.length; index += 1) {
      const source = this.sourceOptions[index];
      const selected = this.questionnaireState.highlightedRow === index;
      const checked = this.questionnaireState.checked.has(source.id);
      const marker = selected ? this.config.theme.fg("accent", "› ") : "  ";
      const check = this.questionnaireState.config.selection === "multi"
        ? (checked ? this.config.theme.fg("success", "☑ ") : this.config.theme.fg("muted", "☐ "))
        : "";
      const comment = this.questionnaireState.comments.has(source.id)
        ? this.config.theme.fg("warning", " ✎")
        : "";
      const label = `${marker}${check}${source.label}${comment}`;
      addPrefixed("", label, selected ? "accent" : "text");

      if (source.description) {
        addPrefixed("     ", source.description, "muted");
      }
      if (selected) {
        const commentText = this.questionnaireState.comments.get(source.id);
        if (commentText) addPrefixed("     ", `✎ ${commentText}`, "dim");
      }
    }

    if (this.questionnaireState.config.allowFreeform !== false) {
      const row = this.sourceOptions.length;
      const selected = this.questionnaireState.highlightedRow === row;
      const marker = selected ? this.config.theme.fg("accent", "› ") : "  ";
      const draft = this.questionnaireState.freeformDraft;
      const suffix = draft ? ` — ${draft}` : "";
      addPrefixed("", `${marker}${this.config.theme.fg(selected ? "accent" : "text", `Type a response…${suffix}`)}`);
    }
  }

  private helpText(): string {
    if (this.questionnaireState.config.selection === "multi") {
      return "↑↓/jk navigate · Space toggle · Enter submit · c comment · Esc cancel";
    }
    return "↑↓/jk navigate · Enter select · c comment · Esc cancel";
  }

  private editorHelpText(): string {
    return this.questionnaireState.mode === "comment"
      ? "Enter save comment · Esc discard"
      : "Enter save response · Esc discard";
  }

  private editingOption(): NormalizedOption | undefined {
    const id = this.questionnaireState.editingOptionId;
    return id ? this.optionsById.get(id) : undefined;
  }

  private isFreeformRow(): boolean {
    return this.questionnaireState.highlightedRow >= this.sourceOptions.length;
  }

  private rowCount(): number {
    return this.sourceOptions.length + (this.questionnaireState.config.allowFreeform === false ? 0 : 1);
  }

  private move(delta: number): void {
    this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "move", delta }));
    this.requestRender();
  }

  private toggle(): void {
    const next = transitionQuestionnaire(this.questionnaireState, { type: "toggle" });
    this.applyState(next);
    this.finishIfAnswered(next);
    this.requestRender();
  }

  private openFreeform(): void {
    if (!this.isFreeformRow()) return;
    const next = transitionQuestionnaire(this.questionnaireState, { type: "openFreeform" });
    this.applyState(next);
    this.editor.setText(next.editorDraft);
    this.editor.focused = this._focused;
    this.requestRender();
  }

  private applyState(next: QuestionnaireState): void {
    const previousMode = this.questionnaireState.mode;
    const modeChanged = next.mode !== previousMode;
    this.questionnaireState = next;
    if (modeChanged) {
      this.editor.focused = this._focused && next.mode !== "select";
      if (previousMode === "select" && next.mode !== "select") {
        this.editor.setText(next.editorDraft);
      }
    }
  }

  private finishIfAnswered(state: QuestionnaireState): void {
    if (!state.answer || this.completedAnswer) return;
    const answer = this.toAskAnswer(state.answer);
    this.completedAnswer = answer;
    this.editor.focused = false;
    this.config.onSubmit?.(answer);
  }

  private toAskAnswer(answer: NonNullable<QuestionnaireState["answer"]>): AskAnswer {
    const selections = answer.selections.map((selection) => {
      const source = this.optionsById.get(selection.id);
      const result: AskOption & { comment?: string } = {
        label: source?.label ?? selection.label,
      };
      if (source?.description) result.description = source.description;
      if (selection.comment) result.comment = selection.comment;
      return result;
    });
    return {
      selections,
      ...(answer.freeform ? { freeform: answer.freeform } : {}),
    };
  }

  private requestRender(): void {
    this.config.tui.requestRender();
  }
}

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

function isLiteral(data: string, expected: string): boolean {
  return data === expected || parseKey(data) === expected;
}

function safeWidth(width: number): number {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1);
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

function addWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number): void {
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= width) {
    for (const line of wrapTextWithAnsi(`${prefix}${text}`, width)) {
      lines.push(fit(line, width));
    }
    return;
  }

  const available = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(text, available);
  const continuation = " ".repeat(prefixWidth);
  for (let index = 0; index < wrapped.length; index += 1) {
    lines.push(fit(`${index === 0 ? prefix : continuation}${wrapped[index]}`, width));
  }
}
