import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";

import type { CompletionNotifyMode, SubagentSettings, WidgetMode, WidgetPlacement } from "../settings.js";
import { isCancelKey, isDownKey, isEnterKey, isUpKey, type SubagentKeybindings } from "./input.js";

export type SubagentSettingsChange =
  | { kind: "widgetPlacement"; value: WidgetPlacement }
  | { kind: "widgetMode"; value: WidgetMode }
  | { kind: "completionNotify"; value: CompletionNotifyMode }
  | { kind: "maxConcurrentSubagents"; value: number }
  | { kind: "maxTasksPerRun"; value: number }
  | { kind: "maxConversations"; value: number }
  | { kind: "widgetMaxRowsPerSection"; value: number };

export function applySubagentSettingsChange(
  settings: SubagentSettings,
  change: SubagentSettingsChange,
): SubagentSettings {
  switch (change.kind) {
    case "widgetPlacement":
      return { ...settings, widgetPlacement: change.value };
    case "widgetMode":
      return { ...settings, widgetMode: change.value };
    case "completionNotify":
      return { ...settings, runtime: { ...settings.runtime, completionNotify: change.value } };
    case "maxConcurrentSubagents":
      return { ...settings, runtime: { ...settings.runtime, maxConcurrentSubagents: change.value } };
    case "maxTasksPerRun":
      return { ...settings, runtime: { ...settings.runtime, maxTasksPerRun: change.value } };
    case "maxConversations":
      return { ...settings, runtime: { ...settings.runtime, maxConversations: change.value } };
    case "widgetMaxRowsPerSection":
      return { ...settings, display: { ...settings.display, widgetMaxRowsPerSection: change.value } };
  }
}

type SettingSection = "Interface" | "Notifications" | "Runtime";
type SettingId = SubagentSettingsChange["kind"];

interface SettingDefinition {
  id: SettingId;
  section: SettingSection;
  label: string;
  currentValue: string;
  description: string;
  values?: string[];
}

export class SubagentSettingsComponent implements Component, Focusable {
  private readonly items: SettingDefinition[];
  private selected = 0;
  private editor?: Input;
  private validationError = "";
  private _focused = false;

  constructor(
    settings: SubagentSettings,
    private readonly theme: Theme,
    private readonly keybindings: SubagentKeybindings,
    private readonly onChange: (change: SubagentSettingsChange) => void,
    private readonly done: () => void,
    private readonly requestRender: () => void = () => {},
  ) {
    this.items = createSettingDefinitions(settings);
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    if (this.editor) this.editor.focused = value;
  }
  get isEditing(): boolean { return Boolean(this.editor); }

  invalidate(): void { this.editor?.invalidate(); }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (safeWidth < 56) {
      return [...this.renderIndex(safeWidth), this.dim("─".repeat(safeWidth)), ...this.renderSelected(safeWidth)].map(line => fit(line, safeWidth));
    }

    const leftWidth = Math.max(26, Math.floor(safeWidth * 0.38));
    const rightWidth = Math.max(1, safeWidth - leftWidth - 3);
    const left = this.renderIndex(leftWidth);
    const right = this.renderSelected(rightWidth);
    const height = Math.max(left.length, right.length);
    return Array.from({ length: height }, (_, index) => {
      const leftLine = fit(left[index] ?? "", leftWidth);
      const rightLine = fit(right[index] ?? "", rightWidth);
      return `${pad(leftLine, leftWidth)} ${this.dim("│")} ${rightLine}`;
    });
  }

  handleInput(data: string): void {
    if (this.editor) {
      this.editor.handleInput(data);
      this.requestRender();
      return;
    }
    if (isCancelKey(data, this.keybindings)) {
      this.done();
      return;
    }
    if (isUpKey(data, this.keybindings)) this.selected = Math.max(0, this.selected - 1);
    else if (isDownKey(data, this.keybindings)) this.selected = Math.min(this.items.length - 1, this.selected + 1);
    else if (isEnterKey(data, this.keybindings) || data === " ") this.activateSelected();
    else return;
    this.requestRender();
  }

  private renderIndex(width: number): string[] {
    const lines: string[] = [""];
    const maxValueWidth = Math.max(...this.items.map(item => visibleWidth(settingListValue(item))));
    const labelWidth = Math.min(18, Math.max(1, width - 5 - maxValueWidth));
    let section: SettingSection | undefined;
    for (const [index, item] of this.items.entries()) {
      if (item.section !== section) {
        if (section) lines.push("");
        section = item.section;
        lines.push(`  ${this.accent(section.toUpperCase())}`);
      }
      const enabled = this.isEnabled(item);
      const marker = index === this.selected ? this.accent("┃") : " ";
      const label = !enabled ? this.dim(item.label) : index === this.selected ? this.text(item.label) : this.muted(item.label);
      const rawValue = settingListValue(item);
      const value = enabled ? this.accent(rawValue) : this.dim(rawValue);
      const prefix = `  ${marker} `;
      lines.push(`${prefix}${pad(fit(label, labelWidth), labelWidth)} ${value}`);
    }
    lines.push("");
    return lines;
  }

  private renderSelected(width: number): string[] {
    const item = this.items[this.selected];
    const enabled = this.isEnabled(item);
    const lines = [
      "",
      `${this.text(item.label)} ${this.muted(`· ${item.section}`)}`,
      ...wrapTextWithAnsi(item.description, Math.max(1, width - 2)).map(line => `  ${line}`),
      "",
    ];

    if (!enabled) {
      lines.push(
        this.dim("Unavailable while Widget mode is summary."),
        this.dim("Set Widget mode to progress to configure progress rows."),
      );
      return lines;
    }

    lines.push(`${this.muted("current")} ${this.accent(item.currentValue)}`, "");
    if (this.editor) {
      lines.push(this.muted("Enter a positive whole number"), ...(this.editor.render(Math.max(4, width - 2)).map(line => `  ${line}`)));
      if (this.validationError) lines.push(this.error(this.validationError));
      lines.push("", this.dim("Enter saves · Esc cancels"));
    } else if (item.values) {
      lines.push(`${this.muted("options")} ${item.values.join(", ")}`, "", this.dim("Enter/Space cycles values · changes save immediately"));
    } else {
      lines.push(this.dim("Enter/Space to type any positive whole number"));
    }

    lines.push("", this.accent(item.id === "completionNotify" ? "BEHAVIOR" : "LIVE PREVIEW"), ...this.renderPreview(item, width));
    return lines;
  }

  private renderPreview(item: SettingDefinition, width: number): string[] {
    if (item.id === "completionNotify") return this.notificationPreview(item.currentValue, width);
    if (item.id === "maxConcurrentSubagents") {
      const value = positiveInt(item.currentValue);
      const shown = Math.min(value, 6);
      return [this.success(`${"● ".repeat(shown).trim()}${value > shown ? `  +${value - shown}` : ""}`), this.muted(`${value} tree-wide running slots; additional work queues.`)];
    }
    if (item.id === "maxTasksPerRun") return [this.success(`run(tasks: [ … up to ${item.currentValue} … ])`), this.muted("Larger task arrays are rejected before work starts.")];
    if (item.id === "maxConversations") {
      const value = positiveInt(item.currentValue);
      return [this.success(`${Math.max(0, value - 1)} / ${value} retained`), this.muted("One spawn remains before capacity is reached."), this.success("remove → frees capacity")];
    }
    return this.widgetPreview(item.id, width);
  }

  private widgetPreview(selectedId: SettingId, width: number): string[] {
    const placement = this.value("widgetPlacement") as WidgetPlacement;
    const mode = this.value("widgetMode") as WidgetMode;
    if (selectedId === "widgetMaxRowsPerSection" && mode !== "progress") return [this.dim("Only available in progress mode.")];

    const editor = [this.dim("┌─ Editor ───────────────┐"), this.text("│ Ask Pi anything…       │"), this.dim("└────────────────────────┘")];
    if (placement === "off") return [...editor, this.dim("(subagent widget hidden)")];

    const widget = mode === "summary"
      ? [this.accent("SUBAGENTS"), this.success("Subagents  2 running · 1 queued · 12 retained")]
      : [this.accent("SUBAGENTS"), ...this.progressRowsPreview(positiveInt(this.value("widgetMaxRowsPerSection")), width)];
    return placement === "aboveEditor" ? [...widget, ...editor] : [...editor, ...widget];
  }

  private progressRowsPreview(limit: number, width: number): string[] {
    const row = (index: number, status = "running") => truncateToWidth(`${status === "queued" ? "○" : "●"} task-${index} · ${status}`, Math.max(1, width), "…");
    if (limit <= 4) return [...Array.from({ length: limit }, (_, index) => this.success(row(index + 1, index === limit - 1 ? "queued" : "running"))), this.muted("+2 more")];
    return [
      ...Array.from({ length: 3 }, (_, index) => this.success(row(index + 1))),
      this.muted(`⋮ ${limit - 4} ${limit - 4 === 1 ? "row" : "rows"}`),
      this.success(row(limit, "queued")),
      this.muted("+2 more"),
    ];
  }

  private notificationPreview(mode: string, width: number): string[] {
    if (mode === "none") return [this.muted("child completes"), this.muted("↓"), this.dim("no automatic notification")];
    const middle = mode === "auto" ? "wait for parent to become idle" : "next eligible active-turn opportunity";
    const result = mode === "auto" ? "notify and trigger response" : "steer notification";
    const lines = [this.muted("child completes"), this.muted("↓"), ...wrapTextWithAnsi(middle, Math.max(1, width)).map(line => this.muted(line)), this.muted("↓"), this.success(result)];
    if (mode === "steer") lines.push("", ...wrapTextWithAnsi("If the parent is idle, notify and trigger a response instead.", Math.max(1, width)).map(line => this.dim(line)));
    return lines;
  }

  private activateSelected(): void {
    const item = this.items[this.selected];
    if (!this.isEnabled(item)) return;
    if (item.values) {
      const index = item.values.indexOf(item.currentValue);
      item.currentValue = item.values[(index + 1) % item.values.length];
      this.onChange(settingChange(item.id, item.currentValue));
      return;
    }
    const editor = new Input();
    editor.setValue(item.currentValue);
    editor.handleInput("\x1b[F");
    editor.focused = this._focused;
    editor.onSubmit = value => this.commitNumber(item, value);
    editor.onEscape = () => this.cancelEditing();
    this.validationError = "";
    this.editor = editor;
  }

  private commitNumber(item: SettingDefinition, value: string): void {
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
      this.validationError = "Enter a positive whole number.";
      this.requestRender();
      return;
    }
    item.currentValue = String(parsed);
    this.editor = undefined;
    this.validationError = "";
    this.onChange(settingChange(item.id, item.currentValue));
    this.requestRender();
  }

  private cancelEditing(): void {
    this.editor = undefined;
    this.validationError = "";
    this.requestRender();
  }

  private isEnabled(item: SettingDefinition): boolean {
    return item.id !== "widgetMaxRowsPerSection" || this.value("widgetMode") === "progress";
  }
  private value(id: SettingId): string { return this.items.find(item => item.id === id)!.currentValue; }
  private text(value: string): string { return this.theme.fg?.("text", value) ?? value; }
  private accent(value: string): string { return this.theme.fg?.("accent", value) ?? value; }
  private success(value: string): string { return this.theme.fg?.("success", value) ?? value; }
  private muted(value: string): string { return this.theme.fg?.("muted", value) ?? value; }
  private dim(value: string): string { return this.theme.fg?.("dim", value) ?? value; }
  private error(value: string): string { return this.theme.fg?.("error", value) ?? value; }
}

function createSettingDefinitions(settings: SubagentSettings): SettingDefinition[] {
  return [
    { id: "widgetPlacement", section: "Interface", label: "Widget placement", currentValue: settings.widgetPlacement, values: ["belowEditor", "aboveEditor", "off"], description: "Place live subagent activity relative to the editor." },
    { id: "widgetMode", section: "Interface", label: "Widget mode", currentValue: settings.widgetMode, values: ["summary", "progress"], description: "Show a retained-conversation summary or individual active runs." },
    { id: "widgetMaxRowsPerSection", section: "Interface", label: "Progress rows", currentValue: String(settings.display.widgetMaxRowsPerSection), description: "Maximum visible active progress rows before an overflow line appears." },
    { id: "completionNotify", section: "Notifications", label: "Completion notify", currentValue: settings.runtime.completionNotify, values: ["auto", "steer", "none"], description: "Choose how completed child runs notify the parent conversation." },
    { id: "maxConcurrentSubagents", section: "Runtime", label: "Max running", currentValue: String(settings.runtime.maxConcurrentSubagents), description: "Maximum concurrently running subagents across the recursive delegation tree." },
    { id: "maxTasksPerRun", section: "Runtime", label: "Max tasks per run", currentValue: String(settings.runtime.maxTasksPerRun), description: "Maximum tasks accepted by one subagent run call." },
    { id: "maxConversations", section: "Runtime", label: "Max conversations", currentValue: String(settings.runtime.maxConversations), description: "Maximum number of conversations retained by the runtime." },
  ];
}

function settingChange(id: SettingId, value: string): SubagentSettingsChange {
  if (id === "widgetPlacement") return { kind: id, value: value as WidgetPlacement };
  if (id === "widgetMode") return { kind: id, value: value as WidgetMode };
  if (id === "completionNotify") return { kind: id, value: value as CompletionNotifyMode };
  return { kind: id, value: Number(value) };
}
function settingListValue(item: SettingDefinition): string { return item.values ? `‹ ${item.currentValue} ›` : `[ ${item.currentValue} ]`; }
function positiveInt(value: string): number { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1; }
function fit(text: string, width: number): string { return visibleWidth(text) > width ? truncateToWidth(text, width, "") : text; }
function pad(text: string, width: number): string { return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`; }
