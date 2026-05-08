import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

export type WidgetPlacement = "belowEditor" | "aboveEditor" | "off";

export interface SubagentUiSettings {
  widgetPlacement: WidgetPlacement;
}

export const DEFAULT_SUBAGENT_UI_SETTINGS: SubagentUiSettings = {
  widgetPlacement: "belowEditor",
};

export type SubagentUiSettingsLoadResult = {
  settings: SubagentUiSettings;
  warning?: string;
};

const WIDGET_PLACEMENTS = new Set<WidgetPlacement>(["belowEditor", "aboveEditor", "off"]);

export class SubagentUiSettingsStore {
  constructor(readonly settingsPath = join(getAgentDir(), "subagent", "settings.json")) { }

  async load(): Promise<SubagentUiSettingsLoadResult> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizeSettings(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { settings: { ...DEFAULT_SUBAGENT_UI_SETTINGS } };
      }
      return {
        settings: { ...DEFAULT_SUBAGENT_UI_SETTINGS },
        warning: `Invalid subagent UI settings at ${this.settingsPath}; using defaults.`,
      };
    }
  }

  async save(settings: SubagentUiSettings): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}

function normalizeSettings(value: unknown): SubagentUiSettingsLoadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      settings: { ...DEFAULT_SUBAGENT_UI_SETTINGS },
      warning: "Invalid subagent UI settings; using defaults.",
    };
  }

  const widgetPlacement = (value as { widgetPlacement?: unknown }).widgetPlacement;
  if (!WIDGET_PLACEMENTS.has(widgetPlacement as WidgetPlacement)) {
    return {
      settings: { ...DEFAULT_SUBAGENT_UI_SETTINGS },
      warning: "Invalid subagent UI widgetPlacement; using belowEditor.",
    };
  }

  return { settings: { widgetPlacement: widgetPlacement as WidgetPlacement } };
}
