import { todoGlyph } from "./glyphs.js";
import type { Todo, TodoState, TodoStatus } from "./types.js";

export interface TodoCounts {
  open: number;
  completed: number;
  cancelled: number;
}

export type TodoStatusCounts = Record<TodoStatus, number>;

/** A small, plain-text representation used in tool results and model context. */
export function formatTodoSummary(state: TodoState | undefined, includeDescriptions = false): string {
  const tasks = todoTasks(state);
  if (tasks.length === 0) return "No todo tasks.";

  const counts = countTodos(tasks);
  const summary = [
    `${counts.open} open`,
    ...(counts.completed ? [`${counts.completed} completed`] : []),
    ...(counts.cancelled ? [`${counts.cancelled} cancelled`] : []),
  ].join(" · ");

  return [
    `Todo: ${summary}`,
    ...(includeDescriptions && state?.workingOn ? [`Working on: ${state.workingOn}`] : []),
    ...formatTodoTaskLines(state, includeDescriptions),
  ].join("\n");
}

export function formatTodoTaskLines(state: TodoState | undefined, includeDescriptions = false): string[] {
  if (!state) return [];

  const lines: string[] = [];
  for (const phase of state.phases) {
    if (phase.tasks.length === 0) continue;
    lines.push(`${phase.name}:`);
    lines.push(...phase.tasks.map((task) =>
      `  ${taskMarker(task)} ${task.name}${includeDescriptions ? ` — ${task.description}` : ""}`,
    ));
  }
  return lines;
}

/** Formats the complete one-shot Todo snapshot injected after compaction. */
export function formatTodoCompactionContext(state: TodoState): string | undefined {
  if (!state.phases.some((phase) => phase.tasks.length > 0)) return undefined;

  const plan = state.phases.flatMap((phase) => [
    `${phase.name}:`,
    ...(phase.tasks.length === 0
      ? ["  (no tasks)"]
      : phase.tasks.map((task) => `  [${task.status}] ${task.name}: ${task.description}`)),
  ]);
  return [
    "<system-reminder source=\"todo-post-compaction\">",
    "Todo plan after compaction:",
    ...(state.workingOn ? [`Current work: ${state.workingOn}`] : []),
    ...plan,
    "Continue using this plan and keep task statuses current.",
    "Do not mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}

export function countTodoStatuses(tasks: readonly Todo[]): TodoStatusCounts {
  const counts: TodoStatusCounts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

export function countTodos(tasks: readonly Todo[]): TodoCounts {
  const counts = countTodoStatuses(tasks);
  return {
    open: counts.pending + counts.in_progress,
    completed: counts.completed,
    cancelled: counts.cancelled,
  };
}

export function formatTodoProgress(label: string, tasks: readonly Todo[]): string {
  const counts = countTodoStatuses(tasks);
  return [
    label,
    ...(counts.in_progress ? [`${counts.in_progress} active`] : []),
    ...(counts.pending ? [`${counts.pending} pending`] : []),
    ...(counts.completed ? [`${counts.completed} completed`] : []),
    ...(counts.cancelled ? [`${counts.cancelled} cancelled`] : []),
  ].join(" · ");
}

export function taskMarker(task: Pick<Todo, "status">): string {
  return todoGlyph(task.status, true);
}

export function todoTasks(state: TodoState | undefined): readonly Todo[] {
  return state?.phases.flatMap((phase) => phase.tasks) ?? [];
}
