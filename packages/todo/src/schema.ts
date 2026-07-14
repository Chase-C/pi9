import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { TODO_ACTIONS, TODO_STATUSES } from "./types.js";

export const TodoTaskSchema = Type.Object({
  name: Type.String({
    description: "Unique immutable task name within the phase; ~5–10 words describing what, not how.",
  }),
  description: Type.String({
    description: "1–3 sentences expanding on the name with relevant context, constraints, or expected outcome.",
  }),
}, { additionalProperties: false });

export const TodoPhaseSchema = Type.Object({
  name: Type.String({ description: "Unique immutable phase name; 1–2 words." }),
  tasks: Type.Array(TodoTaskSchema, { minItems: 1 }),
}, { additionalProperties: false });

export const TodoTransitionSchema = Type.Object({
  phase: Type.String({ description: "Exact name of an existing phase." }),
  task: Type.String({ description: "Exact name of an existing task within the phase." }),
  status: StringEnum(TODO_STATUSES, { description: "Status to assign to the task." }),
}, { additionalProperties: false });

/** Flat provider-facing schema. Action-specific requirements are enforced by the transition. */
export const TodoParamsSchema = Type.Object({
  action: StringEnum(TODO_ACTIONS),
  phases: Type.Optional(Type.Array(TodoPhaseSchema, { minItems: 1 })),
  transitions: Type.Optional(Type.Array(TodoTransitionSchema, { minItems: 1 })),
  workingOn: Type.Optional(Type.String({ description: "Concise summary of the current work." })),
}, { additionalProperties: false });
