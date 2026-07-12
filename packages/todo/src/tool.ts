import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { formatTodoSummary } from "./format.js";
import { restoreTodoState } from "./persistence.js";
import { renderResult as renderTodoResult } from "./renderer.js";
import { TodoToolFrame, type TodoToolFrameContent, type TodoToolFrameTheme } from "./tool-frame.js";
import { TodoParamsSchema } from "./schema.js";
import { DEFAULT_TODO_UI_SETTINGS, loadTodoUiSettings, type TodoUiSettings } from "./settings.js";
import { createTodoState, todoAddressKey, transitionTodoState } from "./state.js";
import { TODO_STATUSES, type TodoAction, type TodoAddress, type TodoState, type TodoToolDetails } from "./types.js";
import { shouldRenderTodoAction } from "./visibility.js";
import { updateTodoWidget } from "./widget.js";

function taskStatuses(state: TodoState): Map<string, string> {
  return new Map(state.phases.flatMap((phase) => phase.tasks.map((task) => [todoAddressKey(phase.name, task.name), task.status])));
}

function taskAddresses(state: TodoState): Map<string, TodoAddress> {
  return new Map(state.phases.flatMap((phase) => phase.tasks.map((task) => {
    const address = { phase: phase.name, task: task.name };
    return [todoAddressKey(address.phase, address.task), address];
  })));
}

function changedTasks(previous: TodoState, next: TodoState): TodoAddress[] {
  const before = taskStatuses(previous);
  const after = taskStatuses(next);
  const addresses = taskAddresses(next);
  return [...after.keys()].filter((key) => before.get(key) !== after.get(key)).map((key) => addresses.get(key)!);
}

function completedTasks(previous: TodoState, next: TodoState): TodoAddress[] {
  const before = taskStatuses(previous);
  return next.phases.flatMap((phase) => phase.tasks
    .filter((task) => task.status === "completed" && before.has(todoAddressKey(phase.name, task.name)) && before.get(todoAddressKey(phase.name, task.name)) !== "completed")
    .map((task) => ({ phase: phase.name, task: task.name })));
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
      : { ...this.result, details: { ...details, state: this.getState(), changedTasks: [] } };
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
    description: [
      "Maintain a concise phased plan that reflects both intended work and current execution progress.",
      "Actions:",
      "  set: Replace the entire plan. All tasks reset to pending. Use only for a new plan or full re-plan.",
      "  add: Append tasks or phases without touching existing work.",
      "  transition: Update task statuses (" + TODO_STATUSES.join(", ") + ") by exact phase and task name.",
      "  view: Return the plan, optionally filtered to one phase.",
    ].join("\n"),
    promptSnippet: "Track multi-step work with the todo tool; keep statuses current as you go",
    promptGuidelines: [
      "Use todo for non-trivial work with three or more distinct steps; skip todo for simple tasks.",
      "Transition todo statuses immediately and honestly—mark tasks completed only when fully done, not merely attempted, and cancel abandoned tasks rather than leaving them pending.",
      "Todo tasks in_progress must all belong to a single phase; finish or cancel a phase's active tasks before starting the next.",
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
          changedTasks: params.action === "view"
            ? []
            : params.action === "set"
              ? [...taskAddresses(next).values()]
              : changedTasks(previous, next),
          completedTasks: params.action === "transition" ? completedTasks(previous, next) : [],
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
