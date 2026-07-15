import { Type } from "typebox";

import { MAX_TIMEOUT_MS } from "./config.js";

export const AskOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, description: "Short option title; keep distinct across options." }),
  description: Type.Optional(Type.String({ description: "Brief explanation when the label alone is ambiguous." })),
  preview: Type.Optional(Type.String({ description: "Markdown shown to the user, e.g. code, plans, or comparisons; not returned in the answer." })),
}, { additionalProperties: false });

export const AskParamsSchema = Type.Object({
  question: Type.String({ minLength: 1 }),
  context: Type.Optional(Type.String({ description: "Optional background shown above the question, e.g. what prompted the ask." })),
  options: Type.Array(AskOptionSchema, { minItems: 1, description: "Suggested answers." }),
  allowMultiple: Type.Optional(Type.Boolean({ default: false, description: "Allow selecting multiple options. Defaults to false." })),
  allowFreeform: Type.Optional(Type.Boolean({ default: true, description: "Allow a typed response. Defaults to true." })),
  timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_TIMEOUT_MS, description: "Timeout in ms for answers that would go stale; the call returns unanswered on expiry. Zero disables any default." })),
}, { additionalProperties: false });

export const AskSelectionSchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String({ minLength: 1 })),
  comment: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const AskAnswerSchema = Type.Object({
  selections: Type.Array(AskSelectionSchema),
  freeform: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const AskReplayDetailsSchema = Type.Object({
  toolCallId: Type.String({ minLength: 1 }),
  question: Type.String({ minLength: 1 }),
  context: Type.Optional(Type.String({ minLength: 1 })),
  allowMultiple: Type.Boolean(),
  answer: AskAnswerSchema,
}, { additionalProperties: false });

export const AskAnsweredDetailsSchema = Type.Object({
  status: Type.Literal("answered"),
  question: Type.String({ minLength: 1 }),
  answer: AskAnswerSchema,
}, { additionalProperties: false });
