import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { TodoSettings } from "./settings.js";
import { isTerminalTodo, type TodoState } from "./types.js";
import { TodoWidgetComponent } from "./widget-component.js";

export type TodoWidgetSettings = Partial<Pick<
  TodoSettings,
  "widgetPlacement" | "maxVisibleTasks" | "fallbackGlyphs"
>>;

type WidgetComponentFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };
type TodoWidgetUI = {
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  setWidget?: {
    (id: string, content: string[] | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
    (id: string, content: WidgetComponentFactory | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
  };
};

const TERMINAL_WIDGET_DELAY_MS = 5_000;
type TodoWidgetLifecycle = {
  hadOpenTasks: boolean;
  terminalClearTimer?: ReturnType<typeof setTimeout>;
};
const widgetLifecycles = new WeakMap<TodoWidgetUI, TodoWidgetLifecycle>();

export type TodoWidgetContext = {
  hasUI?: boolean;
  ui?: TodoWidgetUI;
};

/** Update (or clear) the persistent todo widget without requiring the host UI at runtime. */
export function updateTodoWidget(ctx: TodoWidgetContext | undefined, state: TodoState | undefined, settings: TodoWidgetSettings = {}): void {
  if (!ctx?.hasUI || !ctx.ui?.setWidget) return;
  const ui = ctx.ui;
  const lifecycle = widgetLifecycles.get(ui) ?? { hadOpenTasks: false };

  try {
    const placement = settings.widgetPlacement ?? "aboveEditor";
    if (placement === "off") {
      cancelTerminalClear(lifecycle);
      widgetLifecycles.delete(ui);
      ui.setWidget!("todo", undefined);
      return;
    }

    const hasTasks = state?.phases.some((phase) => phase.tasks.length > 0) ?? false;
    const hasOpenTasks = state?.phases.some((phase) => phase.tasks.some((task) => !isTerminalTodo(task))) ?? false;
    const showFinalState = hasTasks && !hasOpenTasks
      && (lifecycle.hadOpenTasks || lifecycle.terminalClearTimer !== undefined);
    const visibleState = hasOpenTasks || showFinalState ? state : undefined;
    const factory: WidgetComponentFactory | undefined = visibleState
      ? (tui, theme) => new TodoWidgetComponent(visibleState, theme, {
          maxVisible: settings.maxVisibleTasks,
          fallbackGlyphs: settings.fallbackGlyphs,
          blankLineBelow: placement === "aboveEditor",
        }, tui)
      : undefined;
    ui.setWidget!("todo", factory, { placement });

    if (hasOpenTasks) {
      cancelTerminalClear(lifecycle);
      lifecycle.hadOpenTasks = true;
      widgetLifecycles.set(ui, lifecycle);
    } else if (showFinalState) {
      lifecycle.hadOpenTasks = false;
      if (!lifecycle.terminalClearTimer) {
        const timer = setTimeout(() => {
          widgetLifecycles.delete(ui);
          clearWidget(ui);
        }, TERMINAL_WIDGET_DELAY_MS);
        timer.unref?.();
        lifecycle.terminalClearTimer = timer;
      }
      widgetLifecycles.set(ui, lifecycle);
    } else {
      cancelTerminalClear(lifecycle);
      widgetLifecycles.delete(ui);
    }
  } catch (error) {
    notifyWidgetError(ui, error);
  }
}

function cancelTerminalClear(lifecycle: TodoWidgetLifecycle): void {
  if (lifecycle.terminalClearTimer) clearTimeout(lifecycle.terminalClearTimer);
  delete lifecycle.terminalClearTimer;
}

function clearWidget(ui: TodoWidgetUI): void {
  try {
    ui.setWidget?.("todo", undefined);
  } catch (error) {
    notifyWidgetError(ui, error);
  }
}

function notifyWidgetError(ui: TodoWidgetUI, error: unknown): void {
  ui.notify?.(`Todo widget update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
}
