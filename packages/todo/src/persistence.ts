import type { TodoState, TodoToolDetails } from "./types.js";

export const TODO_TOOL_NAME = "todo";

export const createEmptyTodoState = (): TodoState => ({ phases: [], nextId: 1 });

/** Return an independent copy so restored session data is never mutated in place. */
export function cloneTodoState(state: TodoState): TodoState {
  return structuredClone(state);
}

type BranchContext = {
  sessionManager: {
    getBranch(): readonly unknown[];
  };
};

type ToolResultEntry = {
  type: "message";
  message: {
    role: "toolResult";
    toolName?: unknown;
    isError?: unknown;
    details?: unknown;
  };
};

function isTodoState(value: unknown): value is TodoState {
  if (typeof value !== "object" || value === null) return false;

  const state = value as { phases?: unknown; nextId?: unknown };
  return (
    Array.isArray(state.phases) &&
    typeof state.nextId === "number" &&
    Number.isSafeInteger(state.nextId) &&
    state.nextId >= 1
  );
}

function isTodoToolDetails(value: unknown): value is TodoToolDetails {
  if (typeof value !== "object" || value === null) return false;

  const details = value as { action?: unknown; state?: unknown };
  return typeof details.action === "string" && isTodoState(details.state);
}

function isSuccessfulTodoResult(value: unknown): value is ToolResultEntry {
  if (typeof value !== "object" || value === null) return false;

  const entry = value as Partial<ToolResultEntry>;
  return (
    entry.type === "message" &&
    typeof entry.message === "object" &&
    entry.message !== null &&
    entry.message.role === "toolResult" &&
    entry.message.toolName === TODO_TOOL_NAME &&
    entry.message.isError !== true &&
    isTodoToolDetails(entry.message.details)
  );
}

/**
 * Rebuild todo state from the current session branch, choosing the most recent
 * successful todo result that carries a well-formed state snapshot.
 */
export function restoreTodoState(ctx: BranchContext): TodoState {
  const branch = ctx.sessionManager.getBranch();

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (isSuccessfulTodoResult(entry)) {
      const details = entry.message.details as TodoToolDetails;
      return cloneTodoState(details.state);
    }
  }

  return createEmptyTodoState();
}
