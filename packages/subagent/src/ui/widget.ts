import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { buildWidgetModel } from "../view/session-lines.js";
import { SubagentWidgetComponent } from "../view/widget-component.js";
import type { SubagentSettings, SubagentUiSettings } from "../config/settings.js";

type WidgetComponentFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

type SubagentWidgetContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    setWidget?: {
      (id: string, content: string[] | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
      (id: string, content: WidgetComponentFactory | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
    };
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
    const model = buildWidgetModel(agents, Date.now(), display);
    const factory: WidgetComponentFactory | undefined = model.sections.length > 0
      ? (_tui, theme) => new SubagentWidgetComponent(model, theme)
      : undefined;
    ctx.ui.setWidget("subagent", factory, { placement: settings.widgetPlacement });
  } catch (error) {
    try {
      ctx.ui.notify?.(`Subagent UI update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } catch { }
  }
}
