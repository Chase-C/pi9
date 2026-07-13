import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { TODO_ACTIONS, TODO_STATUSES } from "./types.js";

export const TodoPhaseSchema = Type.Object({
  name: Type.String({ minLength: 1, description: "Unique immutable phase name (1–2 words)." }),
  tasks: Type.Array(Type.String({
    minLength: 1,
    description: "Unique immutable task name within its phase; ideally 5–10 words describing what, not how.",
  })),
}, { additionalProperties: false });

export const TodoTransitionSchema = Type.Object({
  phase: Type.String({ minLength: 1, description: "Exact phase name." }),
  task: Type.String({ minLength: 1, description: "Exact task name within the phase." }),
  status: StringEnum(TODO_STATUSES, { description: "New task status." }),
}, { additionalProperties: false });

/** Flat provider-facing schema. Action-specific requirements are enforced by the transition. */
export const TodoParamsSchema = Type.Object({
  action: StringEnum(TODO_ACTIONS),
  phases: Type.Optional(Type.Array(TodoPhaseSchema)),
  transitions: Type.Optional(Type.Array(TodoTransitionSchema, { minItems: 1 })),
  phase: Type.Optional(Type.String({ minLength: 1, description: "Exact phase to view; omit for the full plan." })),
}, { additionalProperties: false });
