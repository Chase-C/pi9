import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { formatTodoProgress, formatTodoSize, todoTasks } from "./format.js";
import { todoGlyph } from "./glyphs.js";
import { currentTodoPhaseIndex, todoAddressKey } from "./state.js";
import { isTerminalTodo, todoTaskPriority, type Todo, type TodoAddress, type TodoToolDetails } from "./types.js";

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

  const changed = new Set((result.details?.changedTasks ?? []).map(addressKey));
  const selectedPhase = currentTodoPhaseIndex(state.phases);
  const lines = [toolTitle(formatTodoProgress("Todos", tasks), theme)];
  for (const [index, phase] of state.phases.entries()) {
    const heading = `  ${index + 1}. ${formatTodoProgress(phase.name, phase.tasks)}`;
    lines.push(index === selectedPhase ? toolTitle(heading, theme) : paint(theme, "dim", heading));
    for (const task of orderedTasks(phase.tasks)) {
      lines.push(renderTask(phase.name, task, changed, theme, rendererOptions));
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

function renderTask(phase: string, task: Todo, changed: Set<string>, theme: ThemeLike | undefined, options: TodoRendererOptions): string {
  const text = isTerminalTodo(task) && theme?.strikethrough ? theme.strikethrough(task.name) : task.name;
  let line = `    ${todoGlyph(task.status, options.fallbackGlyphs)} ${text}`;
  if ((task.status === "in_progress" || changed.has(todoAddressKey(phase, task.name))) && theme?.bold) line = theme.bold(line);
  return paint(theme, statusColor(task.status), line);
}

function addressKey(address: TodoAddress): string {
  return todoAddressKey(address.phase, address.task);
}

function statusColor(status: string): ThemeColor {
  if (status === "completed") return "success";
  if (status === "in_progress") return "text";
  return "dim";
}

function toolTitle(text: string, theme: ThemeLike | undefined): string {
  const title = theme?.bold ? theme.bold(text) : text;
  return paint(theme, "toolTitle", title);
}

function paint(theme: ThemeLike | undefined, color: ThemeColor, text: string): string {
  return theme?.fg ? theme.fg(color, text) : text;
}

function fallbackText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return result.content?.find((part) => part.type === "text")?.text || "No todo tasks.";
}
