import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { formatTodoSummary } from "./format.js";
import { restoreTodoState } from "./persistence.js";
import { renderResult as renderTodoResult } from "./renderer.js";
import { TodoToolFrame, type TodoToolFrameContent, type TodoToolFrameTheme } from "./tool-frame.js";
import { TodoParamsSchema, type TodoParams } from "./schema.js";
import { DEFAULT_TODO_UI_SETTINGS, loadTodoUiSettings, type TodoUiSettings } from "./settings.js";
import { createTodoState, transitionTodoState } from "./state.js";
import type { TodoAction, TodoState, TodoToolDetails } from "./types.js";
import { shouldRenderTodoAction } from "./visibility.js";
import { updateTodoWidget } from "./widget.js";

function changedTaskIds(previous: TodoState, next: TodoState): string[] {
  const before = new Map(previous.phases.flatMap((phase) => phase.tasks.map((task) => [task.id, `${phase.name}\0${task.content}\0${task.status}`])));
  const after = new Map(next.phases.flatMap((phase) => phase.tasks.map((task) => [task.id, `${phase.name}\0${task.content}\0${task.status}`])));
  return [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id));
}

function completedTaskIds(previous: TodoState, next: TodoState): string[] {
  const before = new Map(previous.phases.flatMap((phase) => phase.tasks.map((task) => [task.id, task.status])));
  return next.phases
    .flatMap((phase) => phase.tasks)
    .filter((task) => before.has(task.id) && task.status === "completed" && before.get(task.id) !== "completed")
    .map((task) => task.id);
}

function createTodoFrame(
  state: "pending" | "success" | "error",
  action: string | undefined,
  content: TodoToolFrameContent,
  theme: TodoToolFrameTheme,
): TodoToolFrame {
  return new TodoToolFrame({
    title: "todo",
    action,
    state,
    content,
    empty: "frame",
  }, theme);
}

type TodoRenderInput = {
  details?: TodoToolDetails;
  content?: readonly { type?: string; text?: string }[];
};
type TodoRenderTheme = Parameters<typeof renderTodoResult>[2];
type TrackedSetRenderer = { toolCallId: string; invalidate?: () => void };

/** Expanded content for the one set result that is allowed to follow in-memory state. */
class LiveSetResult implements Component {
  constructor(
    private readonly result: TodoRenderInput,
    private readonly getState: () => TodoState,
    private readonly isCurrent: () => boolean,
    private readonly theme: TodoRenderTheme,
    private readonly fallbackGlyphs: boolean,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const details = this.result.details;
    const liveResult: TodoRenderInput = !this.isCurrent() || !details
      ? this.result
      : { ...this.result, details: { ...details, state: this.getState(), changedTaskIds: [] } };
    return renderTodoResult(liveResult, { expanded: true }, this.theme, { fallbackGlyphs: this.fallbackGlyphs }).render(width);
  }
}

export function registerTodoTool(pi: ExtensionAPI): void {
  let state = createTodoState();
  let settings: TodoUiSettings = { ...DEFAULT_TODO_UI_SETTINGS };
  let queue: Promise<void> = Promise.resolve();
  let latestSetRenderer: TrackedSetRenderer | undefined;

  const invalidateLatestSetRenderer = (): void => {
    latestSetRenderer?.invalidate?.();
  };

  const restore = (ctx: ExtensionContext): void => {
    state = restoreTodoState(ctx);
    invalidateLatestSetRenderer();
    updateTodoWidget(ctx, state, settings);
  };

  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadTodoUiSettings(ctx);
    settings = loaded.settings;
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Create and update a phased task plan. Use stable task IDs returned by the tool for updates and removal.",
    promptSnippet: "Create and update a phased task plan for multi-step work",
    promptGuidelines: [
      "Use todo for non-trivial multi-step work and keep task statuses synchronized with actual progress.",
      "Prefer updating the existing todo plan over replacing it, and target mutations with the stable task IDs returned by todo.",
      "Do not mark todo tasks completed until their work and verification have succeeded.",
    ],
    parameters: TodoParamsSchema,
    renderShell: "self",

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const run = queue.then(() => {
        const previous = state;
        const next = transitionTodoState(previous, params as TodoAction);
        const details: TodoToolDetails = {
          action: params.action,
          state: next,
          changedTaskIds: params.action === "view" ? [] : changedTaskIds(previous, next),
          completedTaskIds: params.action === "view" ? [] : completedTaskIds(previous, next),
        };
        if (params.action !== "view") {
          state = next;
          invalidateLatestSetRenderer();
        }
        updateTodoWidget(ctx, state, settings);
        return {
          content: [{ type: "text" as const, text: formatTodoSummary(next) }],
          details,
        };
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },

    renderCall(args, theme, context) {
      // The self shell replaces the call with the final result once execution settles. Keeping
      // this slot empty after completion also prevents a visible call and result frame at once.
      if (!context.isPartial || context.isError || !shouldRenderTodoAction(args.action, settings.toolVisibility)) {
        return new Container();
      }
      return createTodoFrame("pending", args.action, undefined, theme);
    },

    renderResult(result, options, theme, context) {
      const details = result.details as TodoToolDetails | undefined;
      const action = details?.action ?? context.args.action;
      if (!context.isError && !shouldRenderTodoAction(action, settings.toolVisibility)) return new Container();

      const isSetResult = !context.isError && details?.action === "set";
      if (isSetResult) {
        if (!latestSetRenderer || latestSetRenderer.toolCallId !== context.toolCallId) {
          latestSetRenderer = { toolCallId: context.toolCallId, invalidate: context.invalidate };
        } else {
          latestSetRenderer.invalidate = context.invalidate;
        }
      }

      // Partial updates are represented by the pending call frame. This keeps streaming updates
      // from briefly rendering two self-owned frames in one tool row.
      if ((options.isPartial || context.isPartial) && !context.isError) return new Container();

      const renderInput = result as TodoRenderInput;
      const content = isSetResult && options.expanded
        ? new LiveSetResult(
          renderInput,
          () => state,
          () => latestSetRenderer?.toolCallId === context.toolCallId,
          theme,
          settings.fallbackGlyphs,
        )
        : renderTodoResult(renderInput, options, theme, { fallbackGlyphs: settings.fallbackGlyphs });
      return createTodoFrame(context.isError ? "error" : "success", action, content, theme);
    },
  });
}
