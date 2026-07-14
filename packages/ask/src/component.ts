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
import { CHECKED_BOX, EMPTY_BOX } from "./glyphs.js";
import type { AskAnswer, ValidatedAskParams } from "./types.js";

type AskComponentOptions = ValidatedAskParams & {
  tui: TUI;
  theme: Theme;
  onSubmit?: (answer: AskAnswer) => void;
  onCancel?: () => void;
};

export class AskComponent implements Component, Focusable {
  private readonly editor: Editor;
  private questionnaireState: QuestionnaireState;
  private cancelled = false;
  private _focused = false;

  constructor(private readonly config: AskComponentOptions) {
    this.questionnaireState = createQuestionnaireState({
      options: config.options,
      allowMultiple: config.allowMultiple,
      allowFreeform: config.allowFreeform,
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
    return this.questionnaireState.answer;
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
    if (this.questionnaireState.answer || this.cancelled) return;

    if (this.questionnaireState.mode !== "select") {
      // Escape is intentionally an editor operation: it discards the draft,
      // while Ctrl+C remains the conventional way to cancel the whole ask.
      if (matchesKey(data, Key.escape)) {
        this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "cancelEditor" }));
        this.requestRender();
      }
      else if (matchesKey(data, Key.ctrl("c"))) {
        this.cancel();
      }
      else {
        this.editor.handleInput(data);
        this.requestRender();
      }
    }
    else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
    }
    else if (matchesKey(data, Key.up) || isLiteral(data, "k")) {
      this.move(-1);
    }
    else if (matchesKey(data, Key.down) || isLiteral(data, "j")) {
      this.move(1);
    }
    else if (matchesKey(data, Key.pageUp)) {
      this.move(-5);
    }
    else if (matchesKey(data, Key.pageDown)) {
      this.move(5);
    }
    else if (matchesKey(data, Key.home)) {
      this.move(-this.questionnaireState.highlightedRow);
    }
    else if (matchesKey(data, Key.end)) {
      const rowCount = this.rowCount();
      this.move(rowCount - 1 - this.questionnaireState.highlightedRow);
    }
    else if (isLiteral(data, "c")) {
      this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "openComment" }));
    }
    else if (matchesKey(data, Key.space)) {
      if (this.isSubmitRow()) {
        this.submit();
      } else if (this.isFreeformRow() && this.questionnaireState.config.allowMultiple) {
        this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "toggleFreeform" }));
        this.requestRender();
      } else {
        this.toggle();
      }
    }
    else if (matchesKey(data, Key.enter)) {
      if (this.isSubmitRow()) {
        this.submit();
      } else if (this.isFreeformRow()) {
        this.openFreeform();
      } else {
        this.toggle();
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

    if (this.config.context) {
      addPrefixed(" ", this.config.context, "muted");
      add("");
    }
    addPrefixed(" ", this.config.theme.bold(this.config.question), "text");
    add("");

    if (this.questionnaireState.mode === "select") {
      this.renderOptions(lines, renderWidth);
      this.renderSubmit(lines, renderWidth);
      add("");
      addPrefixed(" ", this.config.theme.fg("dim", this.helpText()), "dim");
    } else {
      // Keep the options visible while editing so the comment remains tied to
      // the option it belongs to, and so freeform editing does not feel like a
      // separate prompt.
      this.renderOptions(lines, renderWidth);
      const inputPrefix = `    ${this.config.theme.fg("accent", "↳")} `;
      const continuationPrefix = " ".repeat(visibleWidth(inputPrefix));
      const inputWidth = Math.max(1, renderWidth - visibleWidth(inputPrefix));
      const editorLines = this.editor.render(inputWidth).filter(line => visibleWidth(line) > 0);
      for (const [index, line] of editorLines.entries()) {
        add(`${index === 0 ? inputPrefix : continuationPrefix}${line}`);
      }
      addPrefixed(continuationPrefix, this.config.theme.fg("dim", this.editorHelpText()), "dim");
      this.renderSubmit(lines, renderWidth);
    }

    add(this.config.theme.fg("border", "─".repeat(renderWidth)));
    return lines;
  }

  /** Submit the current multi-select answer programmatically. */
  submit(): void {
    if (this.questionnaireState.answer || this.cancelled) return;
    const next = transitionQuestionnaire(this.questionnaireState, { type: "submit" });
    this.applyState(next);
    this.finishIfAnswered(next);
    this.requestRender();
  }

  /** Cancel the ask, invoking onCancel at most once. */
  cancel(): void {
    if (this.questionnaireState.answer || this.cancelled) return;
    this.cancelled = true;
    this.editor.focused = false;
    this.config.onCancel?.();
  }

  private renderOptions(lines: string[], width: number): void {
    const addPrefixed = (prefix: string, text: string, color?: "text" | "muted" | "dim" | "accent") => {
      const styled = color ? this.config.theme.fg(color, text) : text;
      addWrappedWithPrefix(lines, prefix, styled, width);
    };

    const options = this.questionnaireState.config.options;
    for (let index = 0; index < options.length; index += 1) {
      const source = options[index];
      const selected = this.questionnaireState.highlightedRow === index;
      const checked = this.questionnaireState.checked.has(source.label);
      const marker = selected ? this.config.theme.fg("accent", "› ") : "  ";
      const check = this.questionnaireState.config.allowMultiple
        ? `${this.config.theme.fg(checked ? "success" : "muted", checked ? CHECKED_BOX : EMPTY_BOX)} `
        : "";
      const comment = this.questionnaireState.comments.has(source.label)
        ? this.config.theme.fg("warning", " ✎")
        : "";
      const label = `${marker}${check}${source.label}${comment}`;
      addPrefixed("", label, selected ? "accent" : "text");

      if (source.description) {
        addPrefixed("     ", source.description, "muted");
      }
      if (selected) {
        const commentText = this.questionnaireState.comments.get(source.label);
        if (commentText) addPrefixed("     ", `✎ ${commentText}`, "dim");
      }
    }

    if (this.questionnaireState.config.allowFreeform) {
      const row = options.length;
      const selected = this.questionnaireState.highlightedRow === row;
      const marker = selected ? this.config.theme.fg("accent", "› ") : "  ";
      const checked = this.questionnaireState.freeformChecked;
      const check = this.questionnaireState.config.allowMultiple
        ? `${this.config.theme.fg(checked ? "success" : "muted", checked ? CHECKED_BOX : EMPTY_BOX)} `
        : "";
      const draft = this.questionnaireState.freeformDraft;
      const suffix = draft ? ` — ${draft}` : "";
      addPrefixed("", `${marker}${check}${this.config.theme.fg(selected ? "accent" : "text", `Type a response…${suffix}`)}`);
    }
  }

  private renderSubmit(lines: string[], width: number): void {
    if (!this.questionnaireState.config.allowMultiple) return;
    const selected = this.isSubmitRow();
    const marker = selected ? this.config.theme.fg("accent", "› ") : "  ";
    lines.push("");
    addWrappedWithPrefix(
      lines,
      "",
      `${marker}${this.config.theme.fg(selected ? "accent" : "text", "[ Submit ]")}`,
      width,
    );
  }

  private helpText(): string {
    if (this.questionnaireState.config.allowMultiple) {
      return "↑↓/jk navigate · Enter/Space toggle · Enter edit response · c comment · Esc cancel";
    }
    return "↑↓/jk navigate · Enter select · c comment · Esc cancel";
  }

  private editorHelpText(): string {
    return this.questionnaireState.mode === "comment"
      ? "Enter save comment · Esc discard"
      : "Enter save response · Esc discard";
  }

  private isFreeformRow(): boolean {
    return this.questionnaireState.config.allowFreeform
      && this.questionnaireState.highlightedRow === this.questionnaireState.config.options.length;
  }

  private isSubmitRow(): boolean {
    return this.questionnaireState.config.allowMultiple
      && this.questionnaireState.highlightedRow === this.rowCount() - 1;
  }

  private rowCount(): number {
    return this.questionnaireState.config.options.length
      + (this.questionnaireState.config.allowFreeform ? 1 : 0)
      + (this.questionnaireState.config.allowMultiple ? 1 : 0);
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
    if (!state.answer) return;
    this.editor.focused = false;
    this.config.onSubmit?.(state.answer);
  }

  private requestRender(): void {
    this.config.tui.requestRender();
  }
}

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: () => "",
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
