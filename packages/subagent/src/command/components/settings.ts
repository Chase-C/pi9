import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type Component, type SettingItem } from "@earendil-works/pi-tui";

import type { CompletionNotifyMode, SubagentSettings, WidgetLayout, WidgetPlacement } from "../../config/settings.js";
import { accent, fitLinesToWidth, isCancelKey, isDownKey, isEnterKey, isUpKey, type SubagentKeybindings } from "../input.js";

const COUNT_SETTING_VALUES = ["1", "2", "4", "8", "16", "32"];
const ROW_SETTING_VALUES = ["1", "2", "4", "6", "8", "16", "32"];

export type SubagentSettingsChange =
  | { kind: "widgetPlacement"; value: WidgetPlacement }
  | { kind: "widgetLayout"; value: WidgetLayout }
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
    case "widgetLayout":
      return { ...settings, widgetLayout: change.value };
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

export class SubagentSettingsComponent implements Component {
  private readonly settingsList: SettingsList;
  private readonly theme: Theme;

  constructor(
    settings: SubagentSettings,
    theme: Theme,
    private readonly keybindings: SubagentKeybindings,
    onChange: (change: SubagentSettingsChange) => void,
    private readonly done: () => void,
    private readonly requestRender: () => void = () => {},
  ) {
    const items: SettingItem[] = [
      {
        id: "widgetPlacement",
        label: "Widget placement",
        currentValue: settings.widgetPlacement,
        values: ["belowEditor", "aboveEditor", "off"],
        description: "Values: belowEditor, aboveEditor, off. off hides only the progress widget.",
      },
      {
        id: "widgetLayout",
        label: "Widget layout",
        currentValue: settings.widgetLayout,
        values: ["auto", "columns", "stacked"],
        description: "Values: auto, columns, stacked. auto uses side-by-side columns when both sections fit after the content width.",
      },
      {
        id: "completionNotify",
        label: "Completion notify",
        currentValue: settings.runtime.completionNotify,
        values: ["auto", "steer", "none"],
        description: "Values: auto, steer, none. auto fires once the parent is idle; steer injects into the active run before a future model step.",
      },
      {
        id: "maxConcurrentSubagents",
        label: "Max running",
        currentValue: String(settings.runtime.maxConcurrentSubagents),
        values: numericSettingValues(settings.runtime.maxConcurrentSubagents, COUNT_SETTING_VALUES),
        description: "Maximum concurrently running subagents. This is a tree-wide cap across recursive parent/child subagents.",
      },
      {
        id: "maxTasksPerRun",
        label: "Max tasks per run",
        currentValue: String(settings.runtime.maxTasksPerRun),
        values: numericSettingValues(settings.runtime.maxTasksPerRun, COUNT_SETTING_VALUES),
        description: "Maximum tasks accepted in one subagent run call. This limits single-call fanout before tasks enter the queue.",
      },
      {
        id: "maxConversations",
        label: "Max conversations",
        currentValue: String(settings.runtime.maxConversations),
        values: numericSettingValues(settings.runtime.maxConversations, ["25", "50", "100", "200", "500"]),
        description: "Maximum number of conversations stored by the runtime.",
      },
      {
        id: "widgetMaxRowsPerSection",
        label: "Widget rows",
        currentValue: String(settings.display.widgetMaxRowsPerSection),
        values: numericSettingValues(settings.display.widgetMaxRowsPerSection, ROW_SETTING_VALUES),
        description: "Maximum visible rows per widget section before showing a +N more overflow line.",
      },
    ];
    this.settingsList = new SettingsList(
      items,
      items.length,
      getSubagentSettingsListTheme(theme),
      (id, newValue) => {
        if (id === "widgetPlacement") onChange({ kind: "widgetPlacement", value: newValue as WidgetPlacement });
        else if (id === "widgetLayout") onChange({ kind: "widgetLayout", value: newValue as WidgetLayout });
        else if (id === "completionNotify") onChange({ kind: "completionNotify", value: newValue as CompletionNotifyMode });
        else if (id === "maxConcurrentSubagents") onChange({ kind: "maxConcurrentSubagents", value: Number(newValue) });
        else if (id === "maxTasksPerRun") onChange({ kind: "maxTasksPerRun", value: Number(newValue) });
        else if (id === "maxConversations") onChange({ kind: "maxConversations", value: Number(newValue) });
        else if (id === "widgetMaxRowsPerSection") onChange({ kind: "widgetMaxRowsPerSection", value: Number(newValue) });
      },
      done,
    );
    this.theme = theme;
  }

  invalidate(): void { this.settingsList.invalidate(); }

  render(width: number): string[] {
    return fitLinesToWidth([accent(this.theme, "Subagent Settings"), "", ...this.settingsList.render(width)], width);
  }

  handleInput(data: string): void {
    if (isCancelKey(data, this.keybindings)) {
      this.done();
      return;
    }
    this.settingsList.handleInput(normalizeSettingsListInput(data, this.keybindings));
    this.requestRender();
  }

}

function numericSettingValues(current: number, presets: string[]): string[] {
  const currentValue = String(current);
  return presets.includes(currentValue)
    ? presets
    : [currentValue, ...presets];
}

function normalizeSettingsListInput(data: string, keybindings: SubagentKeybindings) {
  if (isUpKey(data, keybindings)) return "\x1b[A";
  if (isDownKey(data, keybindings)) return "\x1b[B";
  if (isEnterKey(data, keybindings)) return "\r";
  return data;
}

function getSubagentSettingsListTheme(theme: Theme) {
  try {
    return getSettingsListTheme();
  } catch {
    return {
      label: (text: string, selected: boolean) => selected ? (theme.bold?.(text) ?? text) : text,
      value: (text: string) => text,
      description: (text: string) => theme.fg?.("dim", text) ?? text,
      cursor: "> ",
      hint: (text: string) => theme.fg?.("dim", text) ?? text,
    };
  }
}
