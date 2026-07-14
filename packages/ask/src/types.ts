import type { Static } from "typebox";

import type { AskOptionSchema, AskParamsSchema } from "./schema.js";

export type AskOption = Static<typeof AskOptionSchema>;
export type AskParams = Static<typeof AskParamsSchema>;

export type ValidatedAskParams = Omit<AskParams, "allowMultiple" | "allowFreeform"> & {
  allowMultiple: boolean;
  allowFreeform: boolean;
};

export type AskAnswer = {
  selections: Array<AskOption & { comment?: string }>;
  freeform?: string;
};

export type AskToolDetails =
  | { status: "answered"; question: string; answer: AskAnswer }
  | { status: "cancelled"; question: string }
  | { status: "ui_unavailable"; question: string };

export type AskResponse = {
  content: Array<{ type: "text"; text: string }>;
  details: AskToolDetails;
};
