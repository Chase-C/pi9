import { DEFAULT_SUBAGENT_UI_SETTINGS, type SubagentUiSettingsStore, type SubagentUiSettings, type SubagentUiSettingsLoadResult } from "./subagent-settings.js";
import { formatWidgetLines, type SubagentSessionDto } from "./subagent-ui.js";

type SubagentWidgetContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    setWidget?: (id: string, lines: string[] | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }) => void;
  };
};

export async function loadSubagentUiSettings(
  ctx: SubagentWidgetContext,
  settingsStore: Pick<SubagentUiSettingsStore, "load">,
) {
  try {
    const result = await settingsStore.load();
    notifySettingsWarning(ctx, result);
    return result.settings;
  } catch (error) {
    const message = `Failed to load subagent UI settings; using defaults. ${error instanceof Error ? error.message : String(error)}`;
    notifySettingsWarning(ctx, { settings: DEFAULT_SUBAGENT_UI_SETTINGS, warning: message });
    return { ...DEFAULT_SUBAGENT_UI_SETTINGS };
  }
}

function notifySettingsWarning(ctx: SubagentWidgetContext, result: SubagentUiSettingsLoadResult) {
  if (!result.warning) return;
  try {
    if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(result.warning, "warning");
    else console.warn(result.warning);
  } catch { }
}

export function updateSubagentWidget(
  ctx: SubagentWidgetContext,
  sessions: SubagentSessionDto[],
  settings: SubagentUiSettings,
) {
  if (!ctx.hasUI || !ctx.ui?.setWidget) return;
  try {
    if (settings.widgetPlacement === "off") {
      ctx.ui.setWidget("subagent", undefined);
      return;
    }
    const lines = formatWidgetLines(sessions);
    ctx.ui.setWidget("subagent", lines.length > 0 ? lines : undefined, { placement: settings.widgetPlacement });
  } catch (error) {
    try {
      ctx.ui.notify?.(`Subagent UI update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } catch { }
  }
}
