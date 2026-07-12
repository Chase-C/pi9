import { TODO_ACTIONS, TODO_STATUSES, type TodoState, type TodoToolDetails } from "./types.js";

export const TODO_TOOL_NAME = "todo";

export const createEmptyTodoState = (): TodoState => ({ phases: [] });

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
  const state = value as { phases?: unknown };
  if (!Array.isArray(state.phases)) return false;

  const phaseNames = new Set<string>();
  let activePhase: string | undefined;
  for (const value of state.phases) {
    if (typeof value !== "object" || value === null) return false;
    const phase = value as { name?: unknown; tasks?: unknown };
    if (!validName(phase.name) || phaseNames.has(phase.name) || !Array.isArray(phase.tasks)) return false;
    phaseNames.add(phase.name);

    const taskNames = new Set<string>();
    for (const value of phase.tasks) {
      if (typeof value !== "object" || value === null) return false;
      const task = value as { name?: unknown; status?: unknown };
      if (!validName(task.name) || taskNames.has(task.name) || !(TODO_STATUSES as readonly unknown[]).includes(task.status)) return false;
      if (task.status === "in_progress") {
        if (activePhase !== undefined && activePhase !== phase.name) return false;
        activePhase = phase.name;
      }
      taskNames.add(task.name);
    }
  }
  return true;
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}

function isTodoToolDetails(value: unknown): value is TodoToolDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as { action?: unknown; state?: unknown };
  return typeof details.action === "string"
    && (TODO_ACTIONS as readonly string[]).includes(details.action)
    && isTodoState(details.state);
}

function isSuccessfulTodoResult(value: unknown): value is ToolResultEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ToolResultEntry>;
  return entry.type === "message"
    && typeof entry.message === "object"
    && entry.message !== null
    && entry.message.role === "toolResult"
    && entry.message.toolName === TODO_TOOL_NAME
    && entry.message.isError !== true
    && isTodoToolDetails(entry.message.details);
}

/** Restores the latest successful todo snapshot from the current session branch. */
export function restoreTodoState(ctx: BranchContext): TodoState {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (isSuccessfulTodoResult(entry)) return cloneTodoState((entry.message.details as TodoToolDetails).state);
  }
  return createEmptyTodoState();
}
