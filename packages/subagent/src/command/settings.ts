import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

import type { CompletionNotifyMode, SubagentSettings, WidgetMode, WidgetPlacement } from "../settings.js";
import { isCancelKey, isDownKey, isEnterKey, isUpKey, type SubagentKeybindings } from "./input.js";

const COUNT_SETTING_VALUES = ["1", "2", "4", "8", "16", "32"];
const ROW_SETTING_VALUES = ["1", "2", "4", "6", "8", "16", "32"];

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
  values: string[];
  description: string;
}

export class SubagentSettingsComponent implements Component {
  private readonly items: SettingDefinition[];
  private selected = 0;

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

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const left = this.renderIndex();
    if (safeWidth < 56) {
      return [...left, this.dim("─".repeat(safeWidth)), ...this.renderSelected(safeWidth)].map(line => fit(line, safeWidth));
    }

    const leftWidth = Math.max(24, Math.floor(safeWidth * 0.34));
    const rightWidth = Math.max(1, safeWidth - leftWidth - 3);
    const right = this.renderSelected(rightWidth);
    const height = Math.max(left.length, right.length);
    return Array.from({ length: height }, (_, index) => {
      const leftLine = fit(left[index] ?? "", leftWidth);
      const rightLine = fit(right[index] ?? "", rightWidth);
      return `${pad(leftLine, leftWidth)} ${this.dim("│")} ${rightLine}`;
    });
  }

  handleInput(data: string): void {
    if (isCancelKey(data, this.keybindings)) {
      this.done();
      return;
    }
    if (isUpKey(data, this.keybindings)) this.selected = Math.max(0, this.selected - 1);
    else if (isDownKey(data, this.keybindings)) this.selected = Math.min(this.items.length - 1, this.selected + 1);
    else if (isEnterKey(data, this.keybindings)) this.cycleSelected();
    else return;
    this.requestRender();
  }

  private renderIndex(): string[] {
    const lines: string[] = [];
    let section: SettingSection | undefined;
    for (const [index, item] of this.items.entries()) {
      if (item.section !== section) {
        if (lines.length) lines.push("");
        section = item.section;
        lines.push(this.muted(section));
      }
      const marker = index === this.selected ? this.success("→") : " ";
      const label = index === this.selected ? this.text(item.label) : this.muted(item.label);
      lines.push(`${marker} ${label}`);
    }
    return lines;
  }

  private renderSelected(width: number): string[] {
    const item = this.items[this.selected];
    const lines = [
      `${this.text(item.label)} ${this.muted(`· ${item.section}`)}`,
      ...wrapTextWithAnsi(item.description, Math.max(1, width - 2)).map(line => `  ${line}`),
      "",
      `${this.muted("current")} ${this.accent(item.currentValue)}`,
      `${this.muted("options")} ${item.values.join(", ")}`,
      "",
      this.muted("Choose a value"),
      ...item.values.map(value => value === item.currentValue
        ? `${this.success("→")} ${this.text(value)}`
        : `  ${this.muted(value)}`),
      "",
      this.dim("Enter cycles values · changes save immediately"),
    ];
    return lines;
  }

  private cycleSelected(): void {
    const item = this.items[this.selected];
    const index = item.values.indexOf(item.currentValue);
    item.currentValue = item.values[(index + 1) % item.values.length];
    this.onChange(settingChange(item.id, item.currentValue));
  }

  private text(value: string): string { return this.theme.fg?.("text", value) ?? value; }
  private accent(value: string): string { return this.theme.fg?.("accent", value) ?? value; }
  private success(value: string): string { return this.theme.fg?.("success", value) ?? value; }
  private muted(value: string): string { return this.theme.fg?.("muted", value) ?? value; }
  private dim(value: string): string { return this.theme.fg?.("dim", value) ?? value; }
}

function createSettingDefinitions(settings: SubagentSettings): SettingDefinition[] {
  return [
    {
      id: "widgetPlacement",
      section: "Interface",
      label: "Widget placement",
      currentValue: settings.widgetPlacement,
      values: ["belowEditor", "aboveEditor", "off"],
      description: "Place live run progress relative to the editor.",
    },
    {
      id: "widgetMode",
      section: "Interface",
      label: "Widget mode",
      currentValue: settings.widgetMode,
      values: ["summary", "progress"],
      description: "Choose a retained-conversation summary or active-run progress rows.",
    },
    {
      id: "widgetMaxRowsPerSection",
      section: "Interface",
      label: "Progress rows",
      currentValue: String(settings.display.widgetMaxRowsPerSection),
      values: numericSettingValues(settings.display.widgetMaxRowsPerSection, ROW_SETTING_VALUES),
      description: "Maximum visible active progress rows before an overflow line appears.",
    },
    {
      id: "completionNotify",
      section: "Notifications",
      label: "Completion notify",
      currentValue: settings.runtime.completionNotify,
      values: ["auto", "steer", "none"],
      description: "Choose how completed child runs notify the parent conversation.",
    },
    {
      id: "maxConcurrentSubagents",
      section: "Runtime",
      label: "Max running",
      currentValue: String(settings.runtime.maxConcurrentSubagents),
      values: numericSettingValues(settings.runtime.maxConcurrentSubagents, COUNT_SETTING_VALUES),
      description: "Maximum concurrently running subagents across the recursive delegation tree.",
    },
    {
      id: "maxTasksPerRun",
      section: "Runtime",
      label: "Max tasks per run",
      currentValue: String(settings.runtime.maxTasksPerRun),
      values: numericSettingValues(settings.runtime.maxTasksPerRun, COUNT_SETTING_VALUES),
      description: "Maximum tasks accepted by one subagent run call.",
    },
    {
      id: "maxConversations",
      section: "Runtime",
      label: "Max conversations",
      currentValue: String(settings.runtime.maxConversations),
      values: numericSettingValues(settings.runtime.maxConversations, ["25", "50", "100", "200", "500"]),
      description: "Maximum number of conversations retained by the runtime.",
    },
  ];
}

function settingChange(id: SettingId, value: string): SubagentSettingsChange {
  if (id === "widgetPlacement") return { kind: id, value: value as WidgetPlacement };
  if (id === "widgetMode") return { kind: id, value: value as WidgetMode };
  if (id === "completionNotify") return { kind: id, value: value as CompletionNotifyMode };
  return { kind: id, value: Number(value) };
}

function numericSettingValues(current: number, presets: string[]): string[] {
  const currentValue = String(current);
  return presets.includes(currentValue) ? presets : [currentValue, ...presets];
}

function fit(text: string, width: number): string {
  return visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
}

function pad(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}
