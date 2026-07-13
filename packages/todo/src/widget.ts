import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { TodoSettings } from "./settings.js";
import type { TodoState } from "./types.js";
import { TodoWidgetComponent } from "./widget-component.js";

export type TodoWidgetSettings = Partial<Pick<
  TodoSettings,
  "widgetPlacement" | "maxVisibleTasks" | "fallbackGlyphs"
>>;

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

    const visibleState = state?.phases.some(phase => phase.tasks.some(task =>
      task.status === "pending" || task.status === "in_progress",
    )) ? state : undefined;
    const factory: WidgetComponentFactory | undefined = visibleState
      ? (tui, theme) => new TodoWidgetComponent(visibleState, theme, {
          maxVisible: settings.maxVisibleTasks,
          fallbackGlyphs: settings.fallbackGlyphs,
          blankLineBelow: placement === "aboveEditor",
        }, tui)
      : undefined;
    ctx.ui.setWidget("todo", factory, { placement });
  } catch (error) {
    ctx.ui.notify?.(`Todo widget update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}
