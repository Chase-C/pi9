import {
  createDefaultSubagentSettings,
  normalizeSettings,
  type SubagentSettings,
  type SubagentSettingsLoadResult,
  type SubagentSettingsStore,
} from "./settings.js";

export interface SubagentSettingsLoadContext {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

export async function loadSubagentSettings(
  ctx: SubagentSettingsLoadContext,
  settingsStore: Pick<SubagentSettingsStore, "load">,
): Promise<SubagentSettings> {
  try {
    const result = await settingsStore.load();
    const normalized = normalizeSettings(result.settings);
    notifySettingsWarning(ctx, result.warning ? result : normalized);
    return normalized.settings;
  } catch (error) {
    const message = `Failed to load subagent UI settings; using defaults. ${error instanceof Error ? error.message : String(error)}`;
    const settings = createDefaultSubagentSettings();
    notifySettingsWarning(ctx, { settings, warning: message });
    return settings;
  }
}

function notifySettingsWarning(ctx: SubagentSettingsLoadContext, result: SubagentSettingsLoadResult) {
  if (!result.warning) return;
  try {
    if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(result.warning, "warning");
    else console.warn(result.warning);
  } catch { }
}
