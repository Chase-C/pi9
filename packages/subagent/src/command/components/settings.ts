import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type Component, type SettingItem } from "@earendil-works/pi-tui";

import type { BackgroundNotifyMode, SubagentSettings, WidgetLayout, WidgetPlacement } from "../../config/settings.js";
import { accent, fitLinesToWidth, isCancelKey, isDownKey, isEnterKey, isUpKey, type SubagentKeybindings } from "../input.js";

const COUNT_SETTING_VALUES = ["1", "2", "4", "8", "16", "32"];
const ROW_SETTING_VALUES = ["1", "2", "4", "6", "8", "16", "32"];

export type SubagentSettingsChange =
  | { kind: "widgetPlacement"; value: WidgetPlacement }
  | { kind: "widgetLayout"; value: WidgetLayout }
  | { kind: "backgroundNotify"; value: BackgroundNotifyMode }
  | { kind: "maxConcurrentSubagents"; value: number }
  | { kind: "maxTasksPerRun"; value: number }
  | { kind: "defaultResumable"; value: boolean }
  | { kind: "widgetShowRetainedSessions"; value: boolean }
  | { kind: "widgetMaxRowsPerSection"; value: number };

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
        description: "Values: auto, columns, stacked. auto uses side-by-side columns when both sections fit after the background content width.",
      },
      {
        id: "backgroundNotify",
        label: "Background notify",
        currentValue: settings.runtime.backgroundNotify,
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
        id: "defaultResumable",
        label: "Default resumable",
        currentValue: String(settings.runtime.defaultResumable),
        values: ["false", "true"],
        description: "Default conversation resumability when agent frontmatter omits it. Per-task overrides still win.",
      },
      {
        id: "widgetShowRetainedSessions",
        label: "Show retained",
        currentValue: String(settings.display.widgetShowRetainedSessions),
        values: ["true", "false"],
        description: "Whether the progress widget includes completed resumable sessions. Disable to reduce widget clutter.",
      },
      {
        id: "widgetMaxRowsPerSection",
        label: "Widget rows",
        currentValue: String(settings.display.widgetMaxRowsPerSection),
        values: numericSettingValues(settings.display.widgetMaxRowsPerSection, ROW_SETTING_VALUES),
        description: "Maximum visible rows per Background or Resumable widget section before showing a +N more overflow line.",
      },
    ];
    this.settingsList = new SettingsList(
      items,
      6,
      getSubagentSettingsListTheme(theme),
      (id, newValue) => {
        if (id === "widgetPlacement") onChange({ kind: "widgetPlacement", value: newValue as WidgetPlacement });
        else if (id === "widgetLayout") onChange({ kind: "widgetLayout", value: newValue as WidgetLayout });
        else if (id === "backgroundNotify") onChange({ kind: "backgroundNotify", value: newValue as BackgroundNotifyMode });
        else if (id === "maxConcurrentSubagents") onChange({ kind: "maxConcurrentSubagents", value: Number(newValue) });
        else if (id === "maxTasksPerRun") onChange({ kind: "maxTasksPerRun", value: Number(newValue) });
        else if (id === "defaultResumable") onChange({ kind: "defaultResumable", value: newValue === "true" });
        else if (id === "widgetShowRetainedSessions") onChange({ kind: "widgetShowRetainedSessions", value: newValue === "true" });
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
