import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { formatTodoSize, todoTasks } from "./format.js";
import { todoTaskPriority, type Todo, type TodoToolDetails } from "./types.js";
import { renderTodoPhaseTitle, renderTodoTaskLine, selectedTodoPhaseIndex } from "./widget-layout.js";

type ThemeLike = Partial<Pick<Theme, "fg" | "bold" | "strikethrough">>;
type ThemeColor = Parameters<Theme["fg"]>[0];

export type TodoRendererOptions = { fallbackGlyphs?: boolean };

export function renderResult(
  result: { details?: TodoToolDetails; content?: readonly { type?: string; text?: string }[] },
  options: { expanded?: boolean } = {},
  theme?: ThemeLike,
  rendererOptions: TodoRendererOptions = {},
): Text {
  const state = result.details?.state;
  if (!state) return new Text(fallbackText(result), 0, 0);

  const tasks = todoTasks(state);
  if (options.expanded !== true) {
    return new Text(paint(theme, "muted", formatTodoSize(state.phases.length, tasks.length)), 0, 0);
  }
  if (tasks.length === 0 && state.phases.length === 0) return new Text(paint(theme, "muted", "No todo tasks."), 0, 0);

  const selectedPhase = selectedTodoPhaseIndex(state.phases);
  const lines: string[] = [];
  for (const [index, phase] of state.phases.entries()) {
    lines.push(renderTodoPhaseTitle(phase, index, index === selectedPhase, theme));
    for (const task of orderedTasks(phase.tasks)) {
      lines.push(renderTodoTaskLine(task, theme, rendererOptions.fallbackGlyphs));
    }
  }
  return new Text(lines.join("\n"), 0, 0);
}

function orderedTasks(tasks: readonly Todo[]): Todo[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => todoTaskPriority(left.task) - todoTaskPriority(right.task) || left.index - right.index)
    .map(({ task }) => task);
}

function paint(theme: ThemeLike | undefined, color: ThemeColor, text: string): string {
  return theme?.fg ? theme.fg(color, text) : text;
}

function fallbackText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return result.content?.find((part) => part.type === "text")?.text || "No todo tasks.";
}
