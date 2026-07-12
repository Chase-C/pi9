import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { TODO_ACTIONS, TODO_STATUSES, type TodoActionName, type TodoPhaseInput, type TodoTransitionInput } from "./types.js";

export const TodoPhaseSchema = Type.Object({
  name: Type.String({ minLength: 1, description: "Immutable phase name, 1 or 2 words, unique." }),
  tasks: Type.Array(Type.String({
    minLength: 1,
    description: "Immutable task name, ideally 5–10 words, what not how, unique within its phase.",
  })),
}, { additionalProperties: false });

export const TodoTransitionSchema = Type.Object({
  phase: Type.String({ minLength: 1, description: "Exact immutable phase name." }),
  task: Type.String({ minLength: 1, description: "Exact immutable task name within the phase." }),
  status: StringEnum(TODO_STATUSES, { description: "New task status." }),
}, { additionalProperties: false });

/** Flat provider-facing schema. Action-specific requirements are enforced by the transition. */
export const TodoParamsSchema = Type.Object({
  action: StringEnum(TODO_ACTIONS),
  phases: Type.Optional(Type.Array(TodoPhaseSchema)),
  transitions: Type.Optional(Type.Array(TodoTransitionSchema, { minItems: 1 })),
  phase: Type.Optional(Type.String({ minLength: 1, description: "Optional exact phase name used to filter view." })),
}, { additionalProperties: false });

/** Broad parameter view used by tool render hooks. */
export type TodoParams = {
  action: TodoActionName;
  phases?: TodoPhaseInput[];
  transitions?: TodoTransitionInput[];
  phase?: string;
};

export const TodoSchema = TodoParamsSchema;
