import type { TodoToolVisibility } from "./settings.js";
import { isTodoActionName } from "./types.js";

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
