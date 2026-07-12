import type { Todo, TodoState } from "./types.js";

export type PhasedTodo = Todo & { phase: string };

export interface TodoCounts {
  open: number;
  completed: number;
  cancelled: number;
}

/** A small, plain-text representation used in tool results and model context. */
export function formatTodoSummary(state: TodoState | undefined): string {
  const tasks = todoTasks(state);
  if (tasks.length === 0) return "No todo tasks.";

  const counts = countTodos(tasks);
  const summary = [
    `${counts.open} open`,
    ...(counts.completed ? [`${counts.completed} completed`] : []),
    ...(counts.cancelled ? [`${counts.cancelled} cancelled`] : []),
  ].join(" · ");

  return [`Todo: ${summary}`, ...formatTodoTaskLines(state)].join("\n");
}

export function formatTodoTaskLines(state: TodoState | undefined): string[] {
  if (!state || state.phases.every((phase) => phase.tasks.length === 0)) return [];
  const lines: string[] = [];
  for (const phase of state.phases) {
    if (phase.tasks.length === 0) continue;
    lines.push(`${phase.name}:`);
    lines.push(...phase.tasks.map((task) => `  ${taskMarker(task)} ${task.name}`));
  }
  return lines;
}

export function countTodos(state: TodoState | readonly Todo[] | undefined): TodoCounts {
  const tasks = Array.isArray(state) ? state : todoTasks(state as TodoState | undefined);
  let open = 0;
  let completed = 0;
  let cancelled = 0;
  for (const task of tasks) {
    if (task.status === "completed") completed++;
    else if (task.status === "cancelled") cancelled++;
    else open++;
  }
  return { open, completed, cancelled };
}

export function taskMarker(task: Pick<Todo, "status">): string {
  switch (task.status) {
    case "completed": return "✓";
    case "in_progress": return "▶";
    case "cancelled": return "×";
    default: return "○";
  }
}

export function todoTasks(state: TodoState | undefined): PhasedTodo[] {
  return state?.phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name }))) ?? [];
}
