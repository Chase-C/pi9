export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = typeof TODO_STATUSES[number];

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

export const TODO_ACTIONS = ["set", "add", "transition", "view"] as const;
export type TodoActionName = typeof TODO_ACTIONS[number];

export function isTodoActionName(value: unknown): value is TodoActionName {
  return typeof value === "string" && (TODO_ACTIONS as readonly string[]).includes(value);
}

export type Todo = {
  readonly name: string;
  readonly description: string;
  readonly status: TodoStatus;
};

export function isTerminalTodo(todo: Pick<Todo, "status">): boolean {
  return todo.status === "completed" || todo.status === "cancelled";
}

export function todoTaskPriority(todo: Pick<Todo, "status">): number {
  if (todo.status === "in_progress") return 0;
  if (todo.status === "pending") return 1;
  return 2;
}

export type TodoPhase = {
  readonly name: string;
  readonly tasks: readonly Todo[];
};

export type TodoState = {
  readonly phases: readonly TodoPhase[];
  readonly workingOn?: string;
};

export type TodoAddress = {
  readonly phase: string;
  readonly task: string;
};

/** Persisted with a successful tool result so session state can be restored. */
export type TodoToolDetails = {
  readonly action: TodoActionName;
  readonly state: TodoState;
  readonly changedTasks: readonly TodoAddress[];
};

export type TodoTaskInput = {
  readonly name: string;
  readonly description: string;
};

export type TodoPhaseInput = {
  readonly name: string;
  readonly tasks: readonly TodoTaskInput[];
};

export type TodoTransitionInput = TodoAddress & {
  readonly status: TodoStatus;
};

export type SetTodoAction = {
  readonly action: "set";
  readonly phases: readonly TodoPhaseInput[];
};

export type AddTodoAction = {
  readonly action: "add";
  readonly phases: readonly TodoPhaseInput[];
};

export type TransitionTodoAction = {
  readonly action: "transition";
  readonly transitions: readonly TodoTransitionInput[];
  readonly workingOn?: string;
};

export type ViewTodoAction = {
  readonly action: "view";
};

export type TodoAction = SetTodoAction | AddTodoAction | TransitionTodoAction | ViewTodoAction;
