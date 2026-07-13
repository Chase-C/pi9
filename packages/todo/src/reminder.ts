import { countTodoStatuses, todoTasks } from "./format.js";
import { currentTodoPhaseIndex } from "./state.js";
import type { TodoState } from "./types.js";

/** Formats the transient model-context reminder for an unfinished todo plan. */
export function formatTodoReminder(state: TodoState): string | undefined {
  const activePhase = state.phases[currentTodoPhaseIndex(state.phases)];
  if (!activePhase) return undefined;

  const activeTasks = activePhase.tasks
    .filter((task) => task.status === "in_progress")
    .map((task) => task.name);
  const counts = countTodoStatuses(todoTasks(state));

  return [
    "<system-reminder>",
    `Active phase: ${activePhase.name}`,
    activeTasks.length > 0 ? `In progress: ${activeTasks.join("; ")}` : "No task is in_progress.",
    `Counts: ${counts.in_progress} in_progress, ${counts.pending} pending, ${counts.completed} completed, ${counts.cancelled} cancelled.`,
    "Review and update the todo if task status has changed.",
    "Do not mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}
