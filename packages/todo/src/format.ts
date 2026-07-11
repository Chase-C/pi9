import type { TodoState } from "./types.js";

type TaskLike = {
  id?: unknown;
  content?: unknown;
  title?: unknown;
  status?: unknown;
  phase?: unknown;
};

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

/** Plain task lines, grouped by phase when phases are present. */
export function formatTodoTaskLines(state: TodoState | undefined): string[] {
  const tasks = todoTasks(state);
  if (tasks.length === 0) return [];

  const phases = new Map<string, TaskLike[]>();
  for (const task of tasks) {
    const phase = taskPhase(task);
    const group = phases.get(phase);
    if (group) group.push(task);
    else phases.set(phase, [task]);
  }

  const showPhases = phases.size > 1 || [...phases.keys()][0] !== "Tasks";
  const lines: string[] = [];
  for (const [phase, phaseTasks] of phases) {
    if (showPhases) lines.push(`${phase}:`);
    lines.push(...phaseTasks.map(task => `${showPhases ? "  " : ""}${taskMarker(task)} ${taskId(task)} ${taskText(task)}`));
  }
  return lines;
}

export function countTodos(state: TodoState | readonly TaskLike[] | undefined): TodoCounts {
  const tasks = Array.isArray(state) ? state : todoTasks(state as TodoState | undefined);
  let open = 0;
  let completed = 0;
  let cancelled = 0;
  for (const task of tasks) {
    const status = taskStatus(task);
    if (status === "completed") completed++;
    else if (status === "cancelled" || status === "canceled" || status === "skipped") cancelled++;
    else open++;
  }
  return { open, completed, cancelled };
}

export function taskMarker(task: TaskLike): string {
  switch (taskStatus(task)) {
    case "completed": return "✓";
    case "in_progress":
    case "in-progress":
    case "active": return "▶";
    case "cancelled":
    case "canceled":
    case "skipped": return "×";
    case "blocked": return "[!]";
    default: return "○";
  }
}

export function taskStatus(task: TaskLike): string {
  return typeof task.status === "string" ? task.status.toLowerCase() : "pending";
}

export function taskId(task: TaskLike): string {
  return typeof task.id === "string" && task.id ? `[${task.id}]` : "[unknown-id]";
}

export function taskText(task: TaskLike): string {
  if (typeof task.content === "string" && task.content) return task.content;
  if (typeof task.title === "string" && task.title) return task.title;
  return "Untitled task";
}

export function taskPhase(task: TaskLike): string {
  return typeof task.phase === "string" && task.phase.trim() ? task.phase : "Tasks";
}

export function todoTasks(state: TodoState | undefined): TaskLike[] {
  const value = state as { phases?: unknown; tasks?: unknown } | undefined;
  if (Array.isArray(value?.phases)) {
    return value.phases.flatMap(phase => {
      const entry = phase as { name?: unknown; tasks?: unknown };
      const name = typeof entry.name === "string" ? entry.name : "Tasks";
      return Array.isArray(entry.tasks)
        ? (entry.tasks as TaskLike[]).map(task => ({ ...task, phase: name }))
        : [];
    });
  }
  return Array.isArray(value?.tasks) ? value.tasks as TaskLike[] : [];
}
