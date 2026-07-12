import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { TodoState } from "./types.js";
import { TodoWidgetComponent } from "./widget-component.js";

export type TodoWidgetPlacement = "belowEditor" | "aboveEditor" | "off";

/**
 * Deliberately structural so this unit does not depend on the settings persistence layer.
 * The widget-prefixed forms allow a future settings module to expose namespaced UI settings.
 */
export type TodoWidgetSettings = {
  widgetPlacement?: TodoWidgetPlacement;
  maxVisibleTasks?: number;
  fallbackGlyphs?: boolean;
};

type WidgetComponentFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

export type TodoWidgetContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    setWidget?: {
      (id: string, content: string[] | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
      (id: string, content: WidgetComponentFactory | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
    };
  };
};

/** Update (or clear) the persistent todo widget without requiring the host UI at runtime. */
export function updateTodoWidget(ctx: TodoWidgetContext | undefined, state: TodoState | undefined, settings: TodoWidgetSettings = {}): void {
  if (!ctx?.hasUI || !ctx.ui?.setWidget) return;
  try {
    const placement = settings.widgetPlacement ?? "aboveEditor";
    if (placement === "off") {
      ctx.ui.setWidget("todo", undefined);
      return;
    }

    const hasVisibleTasks = state?.phases.some(phase => phase.tasks.some(task =>
      task.status === "pending" || task.status === "in_progress",
    )) ?? false;
    const factory: WidgetComponentFactory | undefined = hasVisibleTasks
      ? (tui, theme) => new TodoWidgetComponent(state!, theme, {
          maxVisible: settings.maxVisibleTasks,
          fallbackGlyphs: settings.fallbackGlyphs,
        }, tui)
      : undefined;
    ctx.ui.setWidget("todo", factory, { placement });
  } catch (error) {
    try {
      ctx.ui.notify?.(`Todo widget update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } catch { }
  }
}
