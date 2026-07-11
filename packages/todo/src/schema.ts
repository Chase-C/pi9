import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { TODO_STATUSES, type TodoActionName, type TodoPhaseInput, type TodoStatus, type TodoTaskInput } from "./types.js";

export const TodoTaskSchema = Type.Object({
  content: Type.String({ minLength: 1 }),
  status: Type.Optional(StringEnum(TODO_STATUSES)),
});

export const TodoPhaseSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  tasks: Type.Array(TodoTaskSchema),
});

const SetTodoParamsSchema = Type.Object({
  action: StringEnum(["set"] as const),
  tasks: Type.Optional(Type.Array(TodoTaskSchema)),
  phases: Type.Optional(Type.Array(TodoPhaseSchema)),
});

const AddTodoParamsSchema = Type.Object({
  action: StringEnum(["add"] as const),
  phase: Type.String({ minLength: 1 }),
  tasks: Type.Array(TodoTaskSchema),
});

const UpdateTodoParamsSchema = Type.Object({
  action: StringEnum(["update"] as const),
  id: Type.String({ minLength: 1 }),
  content: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(StringEnum(TODO_STATUSES)),
  phase: Type.Optional(Type.String({ minLength: 1 })),
});

const RemoveTodoParamsSchema = Type.Object({
  action: StringEnum(["remove"] as const),
  id: Type.String({ minLength: 1 }),
});

const ViewTodoParamsSchema = Type.Object({
  action: StringEnum(["view"] as const),
  phase: Type.Optional(Type.String({ minLength: 1 })),
});

/** Provider-facing shape. Action-specific semantic checks remain in the transition. */
export const TodoParamsSchema = Type.Union([
  SetTodoParamsSchema,
  AddTodoParamsSchema,
  UpdateTodoParamsSchema,
  RemoveTodoParamsSchema,
  ViewTodoParamsSchema,
]);

/**
 * Broad provider parameter view. The schema and transition enforce the
 * action-specific required fields; this remains broad for tool render hooks.
 */
export type TodoParams = {
  action: TodoActionName;
  tasks?: TodoTaskInput[];
  phases?: TodoPhaseInput[];
  id?: string;
  content?: string;
  status?: TodoStatus;
  phase?: string;
};

export const TodoSchema = TodoParamsSchema;
