import type { TodoToolVisibility } from "./settings.js";
import { TODO_ACTIONS, type TodoActionName } from "./types.js";

function isTodoActionName(action: unknown): action is TodoActionName {
  return typeof action === "string" && (TODO_ACTIONS as readonly string[]).includes(action);
}

/** Returns whether a successful todo action should be shown in tool output. */
export function shouldRenderTodoAction(action: unknown, visibility: TodoToolVisibility): boolean {
  if (!isTodoActionName(action)) return false;

  switch (visibility) {
    case "all":
      return true;
    case "set-only":
      return action === "set";
    case "none":
      return false;
  }
}
