export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = typeof TODO_STATUSES[number];

export const TODO_ACTIONS = ["set", "add", "transition", "view"] as const;
export type TodoActionName = typeof TODO_ACTIONS[number];

export type Todo = {
  name: string;
  status: TodoStatus;
};

export type TodoPhase = {
  name: string;
  tasks: Todo[];
};

export type TodoState = {
  phases: TodoPhase[];
};

export type TodoAddress = {
  phase: string;
  task: string;
};

/** Persisted with a successful tool result so session state can be restored. */
export type TodoToolDetails = {
  action: TodoActionName;
  state: TodoState;
  changedTasks: TodoAddress[];
  completedTasks: TodoAddress[];
};

export type TodoPhaseInput = {
  name: string;
  tasks: string[];
};

export type TodoTransitionInput = TodoAddress & {
  status: TodoStatus;
};

export type SetTodoAction = {
  action: "set";
  phases: TodoPhaseInput[];
};

export type AddTodoAction = {
  action: "add";
  phases: TodoPhaseInput[];
};

export type TransitionTodoAction = {
  action: "transition";
  transitions: TodoTransitionInput[];
};

export type ViewTodoAction = {
  action: "view";
  phase?: string;
};

export type TodoAction = SetTodoAction | AddTodoAction | TransitionTodoAction | ViewTodoAction;
