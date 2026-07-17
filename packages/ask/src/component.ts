import {
  CURSOR_MARKER,
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
  type Keybinding,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import {
  createQuestionnaireState,
  transitionQuestionnaire,
  type QuestionnaireRow,
  type QuestionnaireState,
} from "./state.js";
import {
  composePreviewRow,
  getPreviewPaneLayout,
  renderPreviewMarkdown,
  type PreviewPaneLayout,
} from "./preview.js";
import {
  fitViewport,
  type FocusRange,
  type ViewportOverflow,
} from "./viewport.js";
import type { Ask, AskAnswer } from "./domain.js";
import { CHECKED_BOX, EMPTY_BOX } from "./glyphs.js";

const FRAME_WIDE_PREVIEW = true; // Set to false to compare the same layout without its outer frame.

type AskComponentOptions = Ask & {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  onSubmit?: (answer: AskAnswer) => void;
  onCancel?: () => void;
};

export class AskComponent implements Component, Focusable {
  private readonly editor: Editor;
  private readonly keybindings: KeybindingsManager;
  private readonly previewHeightByWidth = new Map<number, number>();
  private questionnaireState: QuestionnaireState;
  private cancelled = false;
  private _focused = false;

  constructor(private readonly config: AskComponentOptions) {
    this.keybindings = config.keybindings;
    this.questionnaireState = createQuestionnaireState({
      options: config.options,
      allowMultiple: config.allowMultiple,
      allowFreeform: config.allowFreeform,
    });

    this.editor = new Editor(config.tui, editorTheme(config.theme));
    this.editor.onChange = (value) => {
      if (this.questionnaireState.editor.kind === "select") return;
      this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "edit", value }));
    };
    this.editor.onSubmit = (value) => {
      if (this.questionnaireState.editor.kind === "select") return;
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
    this.editor.focused = value && this.questionnaireState.editor.kind !== "select";
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this.questionnaireState.answer || this.cancelled) return;

    if (this.questionnaireState.editor.kind !== "select") {
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
    // Configured Pi bindings take precedence over fixed shortcuts. The order
    // here also defines precedence if a user assigns one key to two Pi actions.
    else if (this.matchesSelect(data, "tui.select.cancel")) {
      this.cancel();
    }
    else if (this.matchesSelect(data, "tui.select.up")) {
      this.move(-1);
    }
    else if (this.matchesSelect(data, "tui.select.down")) {
      this.move(1);
    }
    else if (this.matchesSelect(data, "tui.select.pageUp")) {
      this.move(-5);
    }
    else if (this.matchesSelect(data, "tui.select.pageDown")) {
      this.move(5);
    }
    else if (this.matchesSelect(data, "tui.select.confirm")) {
      this.confirm();
    }
    else if (matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
    }
    else if (matchesKey(data, Key.home)) {
      this.move(-this.questionnaireState.highlightedRow);
    }
    else if (matchesKey(data, Key.end)) {
      this.move(this.questionnaireState.rows.length - 1 - this.questionnaireState.highlightedRow);
    }
    else if (isLiteral(data, "c")) {
      this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "openComment" }));
    }
    else if (matchesKey(data, Key.space)) {
      this.dispatchCurrentRow("toggle");
    }
    else if (isLiteral(data, "k")) {
      this.move(-1);
    }
    else if (isLiteral(data, "j")) {
      this.move(1);
    }
  }

  render(width: number): string[] {
    const availableWidth = safeWidth(width);
    const hasAuthoredPreviews = this.questionnaireState.rows.some(
      row => row.kind === "option" && row.option.preview?.trim(),
    );
    const framed = FRAME_WIDE_PREVIEW
      && hasAuthoredPreviews
      && getPreviewPaneLayout(availableWidth - 4) !== undefined;
    const renderWidth = framed ? availableWidth - 4 : availableWidth;
    const lines: string[] = [];
    const add = (line: string) => lines.push(fit(line, renderWidth));
    const addPrefixed = (prefix: string, text: string, color?: "text" | "muted" | "dim" | "accent") => {
      const styled = color ? this.config.theme.fg(color, text) : text;
      addWrappedWithPrefix(lines, prefix, styled, renderWidth);
    };

    add(this.config.theme.fg("border", "─".repeat(renderWidth)));

    addPrefixed(" ", this.config.theme.bold(this.config.question), "text");
    if (this.config.context) addPrefixed(" ", this.config.context, "muted");
    add("");

    let focus: FocusRange | undefined;
    let footerStart: number;
    let wideBody: {
      start: number;
      end: number;
      previewLines: readonly string[];
      layout: PreviewPaneLayout;
    } | undefined;
    const addFooter = (prefix: string, text: string) => {
      // Keep the footer to one physical row. It is fixed chrome, so wrapping
      // it could consume the entire viewport on a narrow terminal.
      add(fit(`${prefix}${text}`, renderWidth));
    };
    if (this.questionnaireState.editor.kind === "select") {
      const preview = this.highlightedPreview();
      const paneLayout = hasAuthoredPreviews ? getPreviewPaneLayout(renderWidth) : undefined;
      if (paneLayout) {
        const optionLines = [this.config.theme.fg("dim", " OPTIONS"), ""];
        const optionFocus = this.renderOptions(optionLines, paneLayout.leftWidth);
        const submitFocus = this.renderSubmit(optionLines, paneLayout.leftWidth);
        const sectionStart = lines.length;
        const previewLines = [
          this.config.theme.fg("dim", " PREVIEW · FOCUSED OPTION"),
          this.config.theme.fg("dim", "─".repeat(paneLayout.rightWidth)),
          "",
          ...this.renderPreview(preview, paneLayout.rightWidth - 1).map(line => ` ${line}`),
        ];
        const bodyHeight = Math.max(optionLines.length, previewLines.length);
        lines.push(...optionLines, ...Array.from({ length: bodyHeight - optionLines.length }, () => ""));
        wideBody = {
          start: sectionStart,
          end: sectionStart + bodyHeight,
          previewLines,
          layout: paneLayout,
        };
        const sectionFocus = submitFocus ?? optionFocus;
        if (sectionFocus) {
          focus = {
            start: sectionStart + sectionFocus.start,
            end: sectionStart + sectionFocus.end,
          };
        }
      } else {
        const optionFocus = this.renderOptions(lines, renderWidth);
        focus = optionFocus;
        if (hasAuthoredPreviews) {
          const previewStart = lines.length;
          const previewLines = this.renderPreview(preview, renderWidth);
          lines.push(...previewLines);
          if (preview && optionFocus) {
            const firstContentRow = previewLines.findIndex(line => line.trim().length > 0);
            if (firstContentRow >= 0) {
              focus = {
                start: optionFocus.start,
                end: previewStart + firstContentRow + 1,
              };
            }
          }
        }
        const submitFocus = this.renderSubmit(lines, renderWidth);
        focus = submitFocus ?? focus;
      }
      add("");
      footerStart = lines.length;
      addFooter(" ", this.config.theme.fg("dim", this.helpText()));
    } else {
      const activeEditor = this.questionnaireState.editor;
      // Keep the options visible while editing so the comment remains tied to
      // the option it belongs to, and so freeform editing does not feel like a
      // separate prompt.
      const paneLayout = hasAuthoredPreviews ? getPreviewPaneLayout(renderWidth) : undefined;
      const optionLines = paneLayout
        ? [this.config.theme.fg("dim", " OPTIONS"), ""]
        : lines;
      const optionWidth = paneLayout?.leftWidth ?? renderWidth;
      const inputPrefix = `    ${this.config.theme.fg("accent", "↳")} `;
      const continuationPrefix = " ".repeat(visibleWidth(inputPrefix));
      const inputWidth = Math.max(1, optionWidth - visibleWidth(inputPrefix));
      const editorLines = this.editor.render(inputWidth).filter(line => visibleWidth(line) > 0);
      let editorStart = -1;
      let editorEnd = -1;
      this.renderOptions(optionLines, optionWidth, (row) => {
        if (row !== activeEditor.target) return;
        editorStart = optionLines.length;
        for (const [index, line] of editorLines.entries()) {
          optionLines.push(fit(`${index === 0 ? inputPrefix : continuationPrefix}${line}`, optionWidth));
        }
        editorEnd = optionLines.length;
      });
      if (editorEnd > editorStart) {
        const cursorLine = editorLines.findIndex(line => line.includes(CURSOR_MARKER));
        const focusedRow = cursorLine >= 0 ? editorStart + cursorLine : editorEnd - 1;
        focus = { start: focusedRow, end: focusedRow + 1 };
      }

      this.renderSubmit(optionLines, optionWidth);
      if (paneLayout) {
        const sectionStart = lines.length;
        const previewLines = [
          this.config.theme.fg("dim", " PREVIEW · FOCUSED OPTION"),
          this.config.theme.fg("dim", "─".repeat(paneLayout.rightWidth)),
          "",
          ...this.renderPreview(undefined, paneLayout.rightWidth - 1).map(line => ` ${line}`),
        ];
        const bodyHeight = Math.max(optionLines.length, previewLines.length);
        lines.push(...optionLines, ...Array.from({ length: bodyHeight - optionLines.length }, () => ""));
        wideBody = {
          start: sectionStart,
          end: sectionStart + bodyHeight,
          previewLines,
          layout: paneLayout,
        };
        if (focus) focus = { start: sectionStart + focus.start, end: sectionStart + focus.end };
      }

      // The help line is the footer. Keep it adjacent to the bottom border so
      // fitViewport can keep both rows fixed while the editor is focused.
      footerStart = lines.length;
      addFooter(continuationPrefix, this.config.theme.fg("dim", this.editorHelpText()));
    }

    add(this.config.theme.fg("border", "─".repeat(renderWidth)));
    const maxRows = Number.isFinite(this.config.tui.terminal.rows)
      ? this.config.tui.terminal.rows
      : lines.length;
    const rows: LayoutRow[] = wideBody
      ? [
          ...lines.slice(0, wideBody.start).map(line => fullRow(line)),
          ...lines.slice(wideBody.start, wideBody.end).map(left => splitRow(left)),
          ...lines.slice(wideBody.end).map(line => fullRow(line)),
        ]
      : lines.map(line => fullRow(line));
    const visibleRows = fitViewport(rows, focus, maxRows, 1, lines.length - footerStart);
    let previewIndex = 0;

    const projected = visibleRows.map(({ value: row, overflow }) => {
      if (row.kind === "full") {
        return projectFullRow(row.line, overflow, renderWidth);
      }

      const left = `${overflowPrefix(overflow)}${row.left}`;
      const previewLine = wideBody?.previewLines[previewIndex++] ?? "";
      return composePreviewRow(
        left,
        previewLine,
        wideBody!.layout,
        this.config.theme.fg("dim", "│"),
      );
    });
    return framed ? frameDialog(projected, availableWidth, this.config.theme) : projected;
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

  private renderOptions(
    lines: string[],
    width: number,
    afterRow?: (row: QuestionnaireRow) => void,
  ): FocusRange | undefined {
    const addPrefixed = (prefix: string, text: string, color?: "text" | "muted" | "dim" | "accent") => {
      const styled = color ? this.config.theme.fg(color, text) : text;
      addWrappedWithPrefix(lines, prefix, styled, width);
    };

    const multiple = this.questionnaireState.config.allowMultiple;
    let focus: FocusRange | undefined;
    for (const [index, row] of this.questionnaireState.rows.entries()) {
      if (row.kind === "submit") continue;
      const selected = this.questionnaireState.highlightedRow === index;
      const start = lines.length;
      const marker = selected ? this.config.theme.fg("accent", "┃ ") : "  ";
      const checked = row.kind === "option"
        ? this.questionnaireState.checked.has(row.index)
        : this.questionnaireState.freeformChecked;
      const checkboxColor = checked ? "success" : selected ? "text" : "muted";
      const checkbox = multiple
        ? `${this.config.theme.fg(checkboxColor, checked ? CHECKED_BOX : EMPTY_BOX)} `
        : "";

      if (row.kind === "option") {
        const source = row.option;
        const comment = this.questionnaireState.comments.has(row.index)
          ? this.config.theme.fg("warning", " ✎")
          : "";
        addPrefixed(`${marker}${checkbox}`, `${source.label}${comment}`, selected ? "accent" : "text");
        if (source.description) addPrefixed(multiple ? "    " : "  ", source.description, "muted");
        if (selected) {
          const commentText = this.questionnaireState.comments.get(row.index);
          if (commentText) addPrefixed(multiple ? "       " : "     ", `✎ ${commentText}`, "dim");
        }
      } else {
        const suffix = this.questionnaireState.freeformDraft
          ? ` — ${this.questionnaireState.freeformDraft}`
          : "";
        addPrefixed(`${marker}${checkbox}`, `Type a response…${suffix}`, selected ? "accent" : "text");
      }
      if (selected) focus = { start, end: lines.length };
      afterRow?.(row);
    }
    return focus;
  }

  private renderSubmit(lines: string[], width: number): FocusRange | undefined {
    const submitIndex = this.questionnaireState.rows.findIndex(row => row.kind === "submit");
    if (submitIndex < 0) return undefined;
    const selected = this.questionnaireState.highlightedRow === submitIndex;
    const marker = selected ? this.config.theme.fg("accent", "┃ ") : "  ";
    lines.push("");
    const start = lines.length;
    addWrappedWithPrefix(
      lines,
      "",
      `${marker}${this.config.theme.fg(selected ? "accent" : "text", "[ Submit ]")}`,
      width,
    );
    return selected ? { start, end: lines.length } : undefined;
  }

  private helpText(): string {
    const navigate = `${this.keyText("tui.select.up", "↑")}/${this.keyText("tui.select.down", "↓")}/jk navigate`;
    const pages = `${this.keyText("tui.select.pageUp", "PgUp")}/${this.keyText("tui.select.pageDown", "PgDn")} page`;
    const confirm = this.keyText("tui.select.confirm", "Enter");
    const cancel = this.keyText("tui.select.cancel", "Esc");
    const comment = this.matchesAnySelect("c") ? "" : "c comment · ";
    const space = this.matchesAnySelect(" ") ? "" : "/Space";
    if (this.questionnaireState.config.allowMultiple) {
      return `${comment}${navigate} · ${cancel} cancel · ${pages} · ${confirm}${space} toggle · ${confirm} edit response`;
    }
    return `${comment}${navigate} · ${cancel} cancel · ${pages} · ${confirm}${space} select`;
  }

  private matchesAnySelect(data: string): boolean {
    return SELECT_KEYBINDINGS.some(keybinding => this.matchesSelect(data, keybinding));
  }

  private matchesSelect(data: string, keybinding: Keybinding): boolean {
    return this.keybindings.matches(data, keybinding);
  }

  private keyText(keybinding: Keybinding, fallback: string): string {
    const keys = this.keybindings.getKeys(keybinding);
    return keys.length > 0 ? keys.map(formatKey).join("/") : fallback;
  }

  private editorHelpText(): string {
    const submit = this.keyText("tui.input.submit", "Enter");
    return this.questionnaireState.editor.kind === "comment"
      ? `${submit} save comment · Esc discard`
      : `${submit} save response · Esc discard`;
  }

  private highlightedPreview(): string | undefined {
    if (this.questionnaireState.editor.kind !== "select") return undefined;
    const row = this.questionnaireState.rows[this.questionnaireState.highlightedRow];
    return row?.kind === "option" && row.option.preview?.trim() ? row.option.preview : undefined;
  }

  private renderPreview(preview: string | undefined, width: number): string[] {
    const lines = preview ? renderPreviewMarkdown(preview, width) : [];
    let height = this.previewHeightByWidth.get(width);
    if (height === undefined) {
      height = this.questionnaireState.rows.reduce((max, row) => {
        if (row.kind !== "option" || !row.option.preview?.trim()) return max;
        return Math.max(max, renderPreviewMarkdown(row.option.preview, width).length);
      }, 0);
      this.previewHeightByWidth.set(width, height);
    }
    return [...lines, ...Array.from({ length: height - lines.length }, () => "")];
  }

  private move(delta: number): void {
    this.applyState(transitionQuestionnaire(this.questionnaireState, { type: "move", delta }));
    this.requestRender();
  }

  private confirm(): void {
    this.dispatchCurrentRow("activate");
  }

  private dispatchCurrentRow(type: "activate" | "toggle"): void {
    const next = transitionQuestionnaire(this.questionnaireState, { type });
    this.applyState(next);
    this.finishIfAnswered(next);
    this.requestRender();
  }

  private applyState(next: QuestionnaireState): void {
    const previousEditor = this.questionnaireState.editor;
    const editorChanged = next.editor.kind !== previousEditor.kind;
    this.questionnaireState = next;
    if (editorChanged) {
      this.editor.focused = this._focused && next.editor.kind !== "select";
      if (previousEditor.kind === "select" && next.editor.kind !== "select") {
        this.editor.setText(next.editor.draft);
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

const SELECT_KEYBINDINGS: readonly Keybinding[] = [
  "tui.select.cancel",
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
  "tui.select.confirm",
];

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

function formatKey(key: string): string {
  const aliases: Record<string, string> = {
    up: "↑",
    down: "↓",
    pageUp: "PgUp",
    pageDown: "PgDn",
    escape: "Esc",
    enter: "Enter",
    space: "Space",
    home: "Home",
    end: "End",
  };
  return key.split("+").map(part => aliases[part] ?? part).join("+");
}

type LayoutRow =
  | { kind: "full"; line: string }
  | { kind: "split"; left: string };

function fullRow(line: string): LayoutRow {
  return { kind: "full", line };
}

function splitRow(left: string): LayoutRow {
  return { kind: "split", left };
}

function overflowPrefix(overflow: ViewportOverflow | undefined): string {
  if (overflow === "above") return "↑ ";
  if (overflow === "below") return "↓ ";
  if (overflow === "both") return "↕ ";
  return "";
}

function frameDialog(lines: readonly string[], width: number, theme: Theme): string[] {
  const border = (text: string) => theme.fg("border", text);
  const innerWidth = width - 4;
  return lines.map((line, index) => {
    if (index === 0) return border(`╭${"─".repeat(width - 2)}╮`);
    if (index === lines.length - 1) return border(`╰${"─".repeat(width - 2)}╯`);
    const content = fit(line, innerWidth);
    return `${border("│")} ${content}${" ".repeat(innerWidth - visibleWidth(content))} ${border("│")}`;
  });
}

function safeWidth(width: number): number {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1);
}

function projectFullRow(
  line: string,
  overflow: ViewportOverflow | undefined,
  width: number,
): string {
  const prefixed = `${overflowPrefix(overflow)}${line}`;
  // The cursor and current input take precedence over an overflow indicator
  // when both cannot fit on a narrow terminal row.
  if (overflow && visibleWidth(prefixed) > width && line.includes(CURSOR_MARKER)) {
    return fit(line, width);
  }
  return fit(prefixed, width);
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
