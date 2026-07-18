import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { buildWidgetModel } from "../view/conversation-lines.js";
import { SubagentWidgetComponent } from "../view/widget-component.js";
import { DEFAULT_SUBAGENT_UI_SETTINGS, type SubagentSettings, type SubagentUiSettings } from "../config/settings.js";

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

type SubagentWidgetLifecyclePi = {
  on?(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: SubagentWidgetContext) => void): void;
};

type SubagentWidgetConversationSource = {
  listConversations(): AgentSnapshot[];
};

export function registerSubagentWidgetLifecycle(
  pi: SubagentWidgetLifecyclePi,
  source: SubagentWidgetConversationSource,
  getSettings: () => SubagentSettings | SubagentUiSettings,
): void {
  if (typeof pi.on !== "function") return;
  let activeContext: SubagentWidgetContext | undefined;
  const refresh = () => { if (activeContext) updateSubagentWidget(activeContext, source.listConversations(), getSettings()); };
  const unsubscribe = typeof (source as SubagentWidgetConversationSource & { onAgentUpdate?: (listener: () => void) => () => void }).onAgentUpdate === "function"
    ? (source as SubagentWidgetConversationSource & { onAgentUpdate(listener: () => void): () => void }).onAgentUpdate(refresh)
    : undefined;
  pi.on("session_shutdown", (_event, ctx) => { activeContext = undefined; updateSubagentWidget(ctx, [], getSettings()); });
  pi.on("session_start", (_event, ctx) => { activeContext = ctx; refresh(); });
  void unsubscribe;
}

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
    const widgetLayout = settings.widgetLayout ?? DEFAULT_SUBAGENT_UI_SETTINGS.widgetLayout;
    const factory: WidgetComponentFactory | undefined = model.sections.length > 0
      ? (_tui, theme) => new SubagentWidgetComponent(model, theme, widgetLayout)
      : undefined;
    ctx.ui.setWidget("subagent", factory, { placement: settings.widgetPlacement });
  } catch (error) {
    try {
      ctx.ui.notify?.(`Subagent UI update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } catch { }
  }
}
