export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = typeof TODO_STATUSES[number];

export const TODO_ACTIONS = ["set", "add", "update", "remove", "view"] as const;
export type TodoActionName = typeof TODO_ACTIONS[number];

export type Todo = {
  id: string;
  content: string;
  status: TodoStatus;
};

export type TodoPhase = {
  name: string;
  tasks: Todo[];
};

/** The internal, persisted representation of a todo list. */
export type TodoState = {
  phases: TodoPhase[];
  nextId: number;
};

/** Persisted with a successful tool result so session state can be restored. */
export type TodoToolDetails = {
  action: TodoActionName;
  state: TodoState;
  changedTaskIds?: string[];
  /** Tasks whose status changed from a non-completed state to completed. */
  completedTaskIds?: string[];
};

export type TodoTaskInput = {
  content: string;
  status?: TodoStatus;
};

export type TodoPhaseInput = {
  name: string;
  tasks: TodoTaskInput[];
};

export type SetTodoAction = {
  action: "set";
  /** Shorthand for a single phase named Tasks. */
  tasks?: TodoTaskInput[];
  phases?: TodoPhaseInput[];
};

export type AddTodoAction = {
  action: "add";
  phase: string;
  tasks: TodoTaskInput[];
};

export type UpdateTodoAction = {
  action: "update";
  id: string;
  content?: string;
  status?: TodoStatus;
  phase?: string;
};

export type RemoveTodoAction = {
  action: "remove";
  id: string;
};

export type ViewTodoAction = {
  action: "view";
  phase?: string;
};

export type TodoAction = SetTodoAction | AddTodoAction | UpdateTodoAction | RemoveTodoAction | ViewTodoAction;
