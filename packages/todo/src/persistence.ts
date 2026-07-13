import { cloneTodoState, createTodoState, isTodoState } from "./state.js";
import { isTodoActionName, type TodoActionName, type TodoState } from "./types.js";

export const TODO_TOOL_NAME = "todo";

type BranchContext = {
  sessionManager: {
    getBranch(): readonly unknown[];
  };
};

type TodoSnapshotDetails = {
  action: TodoActionName;
  state: TodoState;
};

type TodoResultEntry = {
  type: "message";
  message: {
    role: "toolResult";
    toolName: typeof TODO_TOOL_NAME;
    isError?: unknown;
    details: TodoSnapshotDetails;
  };
};

function isTodoSnapshotDetails(value: unknown): value is TodoSnapshotDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as { action?: unknown; state?: unknown };
  return isTodoActionName(details.action) && isTodoState(details.state);
}

function isSuccessfulTodoResult(value: unknown): value is TodoResultEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as { type?: unknown; message?: unknown };
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return false;

  const message = entry.message as {
    role?: unknown;
    toolName?: unknown;
    isError?: unknown;
    details?: unknown;
  };
  return message.role === "toolResult"
    && message.toolName === TODO_TOOL_NAME
    && message.isError !== true
    && isTodoSnapshotDetails(message.details);
}

/** Restores the latest successful todo snapshot from the current session branch. */
export function restoreTodoState(ctx: BranchContext): TodoState {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (isSuccessfulTodoResult(entry)) return cloneTodoState(entry.message.details.state);
  }
  return createTodoState();
}
