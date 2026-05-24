import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { formatWidgetLines } from "../view/format.js";
import type { SubagentSettings, SubagentUiSettings } from "../config/settings.js";

type SubagentWidgetContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    setWidget?: (id: string, lines: string[] | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }) => void;
  };
};

export function updateSubagentWidget(
  ctx: SubagentWidgetContext,
  agents: AgentSnapshot[],
  settings: SubagentSettings | SubagentUiSettings,
) {
  if (!ctx.hasUI || !ctx.ui?.setWidget) return;
  try {
    if (settings.widgetPlacement === "off") {
      ctx.ui.setWidget("subagent", undefined);
      return;
    }
    const display = (settings as SubagentSettings).display;
    const lines = formatWidgetLines(agents, Date.now(), display);
    ctx.ui.setWidget("subagent", lines.length > 0 ? lines : undefined, { placement: settings.widgetPlacement });
  } catch (error) {
    try {
      ctx.ui.notify?.(`Subagent UI update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } catch { }
  }
}
