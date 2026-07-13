import { Type } from "typebox";

export const AskOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, description: "Short option title." }),
  description: Type.Optional(Type.String({ description: "Optional explanation of this option." })),
}, { additionalProperties: false });

export const AskParamsSchema = Type.Object({
  question: Type.String({ minLength: 1, description: "One focused question to ask the user." }),
  context: Type.Optional(Type.String({ description: "Brief context shown before the question." })),
  options: Type.Optional(Type.Array(AskOptionSchema, { description: "Suggested answers." })),
  allowMultiple: Type.Optional(Type.Boolean({ default: false, description: "Allow selecting multiple options. Defaults to false." })),
  allowFreeform: Type.Optional(Type.Boolean({ default: true, description: "Allow a typed response. Defaults to true." })),
  answered: Type.Optional(Type.Boolean({ description: "Historical-context marker: this question was answered and its original options were removed. Never include it in a new call." })),
}, { additionalProperties: false });
