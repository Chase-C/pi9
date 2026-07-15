import type { Static } from "typebox";

import type {
  AskAnswerSchema,
  AskAnsweredDetailsSchema,
  AskOptionSchema,
  AskParamsSchema,
  AskReplayDetailsSchema,
  AskSelectionSchema,
} from "./schema.js";

export type AskOption = Static<typeof AskOptionSchema>;
export type AskParams = Static<typeof AskParamsSchema>;
export type AskSelection = Static<typeof AskSelectionSchema>;
export type AskAnswer = Static<typeof AskAnswerSchema>;
export type AskReplayDetails = Static<typeof AskReplayDetailsSchema>;
export type AskAnsweredDetails = Static<typeof AskAnsweredDetailsSchema>;

export type ValidatedAskParams = Omit<AskParams, "allowMultiple" | "allowFreeform"> & {
  allowMultiple: boolean;
  allowFreeform: boolean;
};

export type AskToolDetails =
  | AskAnsweredDetails
  | { status: "unanswered"; question: string }
  | { status: "cancelled"; question: string }
  | { status: "ui_unavailable"; question: string };

export type AskResponse = {
  content: Array<{ type: "text"; text: string }>;
  details: AskToolDetails;
};
