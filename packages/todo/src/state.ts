import { TODO_ACTIONS, TODO_STATUSES, type TodoAction, type TodoPhase, type TodoState, type TodoStatus } from "./types.js";

export const DEFAULT_TODO_PHASE = "Tasks";

export function createTodoState(): TodoState {
  return { phases: [{ name: DEFAULT_TODO_PHASE, tasks: [] }], nextId: 1 };
}

/** Returns a deep copy suitable for handing to callers without exposing state. */
export function cloneTodoState(state: TodoState): TodoState {
  return {
    nextId: state.nextId,
    phases: state.phases.map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.map((task) => ({ ...task })),
    })),
  };
}

/**
 * Applies a todo action without mutating either the supplied state or action.
 * Invalid actions throw before a new state is returned.
 */
export function transitionTodoState(state: TodoState, action: TodoAction | unknown): TodoState {
  assertState(state);
  const next = cloneTodoState(state);
  const input = actionRecord(action);
  const actionName = input.action;
  if (typeof actionName !== "string" || !(TODO_ACTIONS as readonly string[]).includes(actionName)) {
    throw new Error("Todo action must be one of: set, add, update, remove, view.");
  }

  switch (actionName) {
    case "set":
      return setTodos(next, input);
    case "add":
      return addTodo(next, input);
    case "update":
      return updateTodo(next, input);
    case "remove":
      return removeTodo(next, input);
    case "view":
      if (input.phase !== undefined) {
        const phase = findPhase(next.phases, phaseName(input.phase, "view phase"));
        next.phases = [phase];
      }
      return next;
    default:
      throw new Error("Unknown todo action.");
  }
}

/** Alias for consumers that use reducer terminology. */
export const applyTodoAction = transitionTodoState;

function setTodos(state: TodoState, action: Record<string, unknown>): TodoState {
  const hasTasks = action.tasks !== undefined;
  const hasPhases = action.phases !== undefined;
  if (hasTasks === hasPhases) {
    throw new Error("set requires exactly one of tasks or phases.");
  }

  const phases = hasTasks
    ? [{ name: DEFAULT_TODO_PHASE, tasks: taskInputs(action.tasks, "tasks") }]
    : phaseInputs(action.phases);
  assertUniquePhaseNames(phases);

  state.phases = phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => makeTodo(state, task.content, task.status ?? "pending")),
  }));
  return state;
}

function addTodo(state: TodoState, action: Record<string, unknown>): TodoState {
  const name = phaseName(action.phase, "add phase");
  const tasks = taskInputs(action.tasks, "add tasks");
  if (tasks.length === 0) throw new Error("add tasks must contain at least one task.");

  let phase = state.phases.find((candidate) => candidate.name === name);
  if (!phase) {
    phase = { name, tasks: [] };
    state.phases.push(phase);
  }
  phase.tasks.push(...tasks.map((task) => makeTodo(state, task.content, task.status ?? "pending")));
  return state;
}

function updateTodo(state: TodoState, action: Record<string, unknown>): TodoState {
  const id = todoId(action.id);
  const hasContent = action.content !== undefined;
  const hasStatus = action.status !== undefined;
  const hasPhase = action.phase !== undefined;
  if (!hasContent && !hasStatus && !hasPhase) {
    throw new Error("update requires at least one of content, status, or phase.");
  }
  const source = state.phases.find((phase) => phase.tasks.some((task) => task.id === id));
  if (!source) throw new Error(`Todo not found: ${id}.`);
  const task = source.tasks.find((candidate) => candidate.id === id)!;
  const content = hasContent ? todoContent(action.content, "update content") : task.content;
  const status = hasStatus ? todoStatus(action.status, "update status")! : task.status;
  const destination = hasPhase ? findPhase(state.phases, phaseName(action.phase, "update phase")) : source;

  if (source !== destination) source.tasks.splice(source.tasks.indexOf(task), 1);
  const updated = { id: task.id, content, status };
  if (source === destination) source.tasks[source.tasks.indexOf(task)] = updated;
  else destination.tasks.push(updated);
  return state;
}

function removeTodo(state: TodoState, action: Record<string, unknown>): TodoState {
  const id = todoId(action.id);
  const phase = state.phases.find((candidate) => candidate.tasks.some((task) => task.id === id));
  if (!phase) throw new Error(`Todo not found: ${id}.`);
  phase.tasks.splice(phase.tasks.findIndex((task) => task.id === id), 1);
  return state;
}

function makeTodo(state: TodoState, content: string, status: TodoStatus) {
  return { id: `task-${state.nextId++}`, content, status };
}

function actionRecord(action: unknown): Record<string, unknown> {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("Todo action must be an object.");
  return action as Record<string, unknown>;
}

function taskInputs(value: unknown, label: string): Array<{ content: string; status?: TodoStatus }> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((task, index) => {
    const input = actionRecord(task);
    return { content: todoContent(input.content, `${label}[${index}].content`), status: todoStatus(input.status, `${label}[${index}].status`) };
  });
}

function phaseInputs(value: unknown): Array<{ name: string; tasks: Array<{ content: string; status?: TodoStatus }> }> {
  if (!Array.isArray(value)) throw new Error("phases must be an array.");
  return value.map((phase, index) => {
    const input = actionRecord(phase);
    return { name: phaseName(input.name, `phases[${index}].name`), tasks: taskInputs(input.tasks, `phases[${index}].tasks`) };
  });
}

function todoContent(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value;
}
function todoId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Todo id must be a non-empty string.");
  return value;
}
function phaseName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value;
}
function todoStatus(value: unknown, label: string): TodoStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(TODO_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of: ${TODO_STATUSES.join(", ")}.`);
  }
  return value as TodoStatus;
}
function findPhase(phases: TodoPhase[], name: string): TodoPhase {
  const phase = phases.find((candidate) => candidate.name === name);
  if (!phase) throw new Error(`Phase not found: ${name}.`);
  return phase;
}
function assertUniquePhaseNames(phases: Array<{ name: string }>): void {
  const names = new Set<string>();
  for (const phase of phases) {
    if (names.has(phase.name)) throw new Error(`Duplicate phase name: ${phase.name}.`);
    names.add(phase.name);
  }
}
function assertState(state: TodoState): void {
  if (!state || typeof state !== "object" || !Array.isArray(state.phases) || !Number.isSafeInteger(state.nextId) || state.nextId < 1) {
    throw new Error("Invalid todo state.");
  }
  assertUniquePhaseNames(state.phases);
  const ids = new Set<string>();
  for (const phase of state.phases) {
    if (typeof phase.name !== "string" || phase.name.trim() === "" || !Array.isArray(phase.tasks)) throw new Error("Invalid todo state.");
    for (const task of phase.tasks) {
      if (!task || typeof task.id !== "string" || typeof task.content !== "string" || !(TODO_STATUSES as readonly string[]).includes(task.status) || ids.has(task.id)) {
        throw new Error("Invalid todo state.");
      }
      ids.add(task.id);
    }
  }
}
