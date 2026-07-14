import { countTodoStatuses, todoTasks } from "./format.js";
import { currentTodoPhaseIndex } from "./state.js";
import { isTerminalTodo, type TodoState } from "./types.js";

/** Formats the transient model-context reminder for an unfinished todo plan. */
export function formatTodoReminder(state: TodoState): string | undefined {
  const activePhase = state.phases[currentTodoPhaseIndex(state.phases)];
  if (!activePhase) return undefined;

  const openTasks = activePhase.tasks.filter((task) => !isTerminalTodo(task));
  const counts = countTodoStatuses(todoTasks(state));

  return [
    "<system-reminder>",
    `Active phase: ${activePhase.name}`,
    ...(state.workingOn ? [`Current work: ${state.workingOn}`] : []),
    "Open tasks in this phase:",
    ...openTasks.map((task) => `- [${task.status}] ${task.name}: ${task.description}`),
    `Counts: ${counts.in_progress} in_progress, ${counts.pending} pending, ${counts.completed} completed, ${counts.cancelled} cancelled.`,
    "Review and update the todo if task status has changed.",
    "Do not mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}
