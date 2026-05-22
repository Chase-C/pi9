import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type Component, type SettingItem } from "@earendil-works/pi-tui";

import type { BackgroundNotifyMode, SubagentSettings, WidgetPlacement } from "../../config/settings.js";
import { fitLinesToWidth, isCancelKey, type SubagentKeybindings, type SubagentSessionsTheme } from "../input.js";

export type SubagentSettingsChange =
  | { kind: "widgetPlacement"; value: WidgetPlacement }
  | { kind: "backgroundNotify"; value: BackgroundNotifyMode };

export class SubagentSettingsComponent implements Component {
  private readonly settingsList: SettingsList;
  private readonly theme: SubagentSessionsTheme;

  constructor(
    settings: SubagentSettings,
    theme: SubagentSessionsTheme,
    private readonly keybindings: SubagentKeybindings,
    onChange: (change: SubagentSettingsChange) => void,
    private readonly done: () => void,
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
        id: "backgroundNotify",
        label: "Background notify",
        currentValue: settings.runtime.backgroundNotify,
        values: ["auto", "steer", "none"],
        description: "Values: auto, steer, none. auto fires once the parent is idle; steer injects into the active run before a future model step.",
      },
    ];
    this.settingsList = new SettingsList(
      items,
      6,
      getSubagentSettingsListTheme(theme),
      (id, newValue) => {
        if (id === "widgetPlacement") onChange({ kind: "widgetPlacement", value: newValue as WidgetPlacement });
        else if (id === "backgroundNotify") onChange({ kind: "backgroundNotify", value: newValue as BackgroundNotifyMode });
      },
      done,
    );
    this.theme = theme;
  }

  invalidate(): void { this.settingsList.invalidate(); }

  render(width: number): string[] {
    return fitLinesToWidth([this.accent("Subagent Settings"), "", ...this.settingsList.render(width)], width);
  }

  handleInput(data: string): void {
    if (isCancelKey(data, this.keybindings)) {
      this.done();
      return;
    }
    this.settingsList.handleInput(data);
  }

  private accent(text: string) {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }
}

function getSubagentSettingsListTheme(theme: SubagentSessionsTheme) {
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
