import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
  countTodos,
  formatTodoSummary,
  taskId,
  taskPhase,
  taskStatus,
  taskText,
  todoTasks,
} from "./format.js";
import { todoGlyph } from "./glyphs.js";
import type { TodoParams } from "./schema.js";
import type { TodoState, TodoToolDetails } from "./types.js";

type ThemeLike = Partial<Pick<Theme, "fg" | "bold" | "strikethrough">>;
type ThemeColor = Parameters<Theme["fg"]>[0];

type TaskLike = { id?: unknown; status?: unknown; phase?: unknown; content?: unknown; title?: unknown };

export type TodoRendererOptions = { fallbackGlyphs?: boolean };

/** Compact title displayed while the todo tool is running. */
export function renderCall(params: TodoParams | undefined, theme?: ThemeLike): Text {
  const action = params?.action;
  const label = typeof action === "string" && action ? `todo ${action}` : "todo";
  return new Text(paint(theme, "toolTitle", label), 0, 0);
}

/**
 * Pi custom result renderer. Collapsed results show the current work at a glance; expanded
 * results show phase progress and every task.
 */
export function renderResult(
  result: { details?: TodoToolDetails; content?: readonly { type?: string; text?: string }[] },
  options: { expanded?: boolean } = {},
  theme?: ThemeLike,
  rendererOptions: TodoRendererOptions = {},
): Text {
  const details = result?.details;
  const state = detailsState(details);
  if (!state) return new Text(fallbackText(result ?? {}), 0, 0);

  const tasks = todoTasks(state);
  if (tasks.length === 0) return new Text(paint(theme, "muted", "No todo tasks."), 0, 0);

  const counts = countTodos(state);
  const header = todoHeader(counts);
  if (!options?.expanded) return new Text(collapsedText(header, tasks, theme, rendererOptions), 0, 0);

  const changed = new Set(changedTaskIds(details));
  const lines = [paint(theme, "muted", header)];
  const phases = groupedTasks(tasks);
  for (const [index, [phase, phaseTasks]] of [...phases.entries()].entries()) {
    lines.push(paint(theme, "toolTitle", `${index + 1}. ${phase} · ${phaseProgress(phaseTasks)}`));
    for (const task of phaseTasks) lines.push(renderTask(task, changed, theme, rendererOptions));
  }
  return new Text(lines.join("\n"), 0, 0);
}

/** Kept available for callers that need the unstyled LLM-facing result text. */
export function formatResultText(details: TodoToolDetails | undefined): string {
  return formatTodoSummary(detailsState(details));
}

function todoHeader(counts: ReturnType<typeof countTodos>): string {
  return [
    `Todo · ${counts.open} open`,
    ...(counts.completed ? [`${counts.completed} completed`] : []),
    ...(counts.cancelled ? [`${counts.cancelled} cancelled`] : []),
  ].join(" · ");
}

function collapsedText(header: string, tasks: TaskLike[], theme: ThemeLike | undefined, options: TodoRendererOptions): string {
  const active = tasks.find((task) => {
    const status = taskStatus(task);
    return status === "in_progress" || status === "in-progress" || status === "active";
  });
  const activeText = active ? `Active: ${taskGlyph(active, options.fallbackGlyphs)} ${taskText(active)}` : undefined;
  return [paint(theme, "muted", header), ...(activeText ? [paint(theme, "warning", activeText)] : []), paint(theme, "dim", "↵ expand")].join(" · ");
}

function groupedTasks(tasks: TaskLike[]): Map<string, TaskLike[]> {
  const phases = new Map<string, TaskLike[]>();
  for (const task of tasks) {
    const phase = taskPhase(task);
    const group = phases.get(phase);
    if (group) group.push(task);
    else phases.set(phase, [task]);
  }
  return phases;
}

function phaseProgress(tasks: TaskLike[]): string {
  const completed = tasks.filter((task) => taskStatus(task) === "completed").length;
  return `${completed}/${tasks.length} completed`;
}

function renderTask(task: TaskLike, changed: Set<string>, theme: ThemeLike | undefined, options: TodoRendererOptions): string {
  const status = taskStatus(task);
  const text = (status === "completed" || status === "cancelled" || status === "canceled" || status === "skipped") && theme?.strikethrough
    ? theme.strikethrough(taskText(task))
    : taskText(task);
  let line = `  ${taskGlyph(task, options.fallbackGlyphs)} ${taskId(task)} ${text}`;
  if (changed.has(taskIdentity(task)) && theme?.bold) line = theme.bold(line);
  return paint(theme, statusColor(status), line);
}

function detailsState(details: TodoToolDetails | undefined): TodoState | undefined {
  const state = (details as { state?: unknown } | undefined)?.state;
  return state && typeof state === "object" ? state as TodoState : undefined;
}

function changedTaskIds(details: TodoToolDetails | undefined): string[] {
  const ids = (details as { changedTaskIds?: unknown } | undefined)?.changedTaskIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

function taskGlyph(task: TaskLike, fallbackGlyphs = false): string {
  const status = taskStatus(task);
  if (status === "completed") return todoGlyph("completed", fallbackGlyphs);
  if (status === "in_progress" || status === "in-progress" || status === "active") return todoGlyph("in_progress", fallbackGlyphs);
  if (status === "cancelled" || status === "canceled" || status === "skipped") return todoGlyph("cancelled", fallbackGlyphs);
  if (status === "pending") return todoGlyph("pending", fallbackGlyphs);
  return "[!]";
}

function taskIdentity(task: TaskLike): string {
  return typeof task.id === "string" ? task.id : "";
}

function statusColor(status: string): ThemeColor {
  if (status === "completed") return "success";
  if (status === "blocked") return "error";
  if (status === "in_progress" || status === "in-progress" || status === "active") return "text";
  if (status === "cancelled" || status === "canceled" || status === "skipped") return "dim";
  return "dim";
}

function paint(theme: ThemeLike | undefined, color: ThemeColor, text: string): string {
  return theme?.fg ? theme.fg(color, text) : text;
}

function fallbackText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  const text = result.content?.find(part => part.type === "text")?.text;
  return text || "No todo tasks.";
}
