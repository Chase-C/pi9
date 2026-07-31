import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const AskOptionSchema = Type.Object({
  label: Type.String({ description: "Short title for this choice." }),
  description: Type.Optional(Type.String({ description: "Brief elaboration on the label." })),
  preview: Type.Optional(Type.String({ description: "Markdown for details that don't fit in short prose." })),
}, { additionalProperties: false });

export const AskParamsSchema = Type.Object({
  question: Type.String({ description: "One focused question for the user to answer." }),
  context: Type.Optional(Type.String({ description: "Background needed to make the decision." })),
  options: Type.Array(AskOptionSchema, { description: "Distinct candidate answers." }),
  allowMultiple: Type.Optional(Type.Boolean({ default: false })),
  allowFreeform: Type.Optional(Type.Boolean({ default: true })),
  timeout: Type.Optional(Type.Boolean({ default: false, description: "Return unanswered after the configured timeout." })),
}, { additionalProperties: false });

export const AskSelectionSchema = Type.Object({
  option: Type.Integer({ minimum: 0 }),
  comment: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const AskAnswerSchema = Type.Object({
  selections: Type.Array(AskSelectionSchema),
  freeform: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const AskReplayDetailsSchema = Type.Object({
  toolCallId: Type.String(),
  answer: AskAnswerSchema,
}, { additionalProperties: false });

export const AskAnsweredDetailsSchema = Type.Object({
  status: Type.Literal("answered"),
  answer: AskAnswerSchema,
}, { additionalProperties: false });

export type AskOption = Static<typeof AskOptionSchema>;
export type AskParams = Static<typeof AskParamsSchema>;
export type AskSelection = Static<typeof AskSelectionSchema>;
export type AskAnswer = Static<typeof AskAnswerSchema>;
export type AskReplayDetails = Static<typeof AskReplayDetailsSchema>;
export type AskAnsweredDetails = Static<typeof AskAnsweredDetailsSchema>;

export type Ask = Omit<AskParams, "allowMultiple" | "allowFreeform"> & {
  allowMultiple: boolean;
  allowFreeform: boolean;
};

export type AskToolDetails =
  | AskAnsweredDetails
  | { status: "unanswered" | "cancelled" | "ui_unavailable" };

export type AskResponse = {
  content: Array<{ type: "text"; text: string }>;
  details: AskToolDetails;
};

export function normalizeAsk(params: AskParams): Ask {
  const question = params.question.trim();
  if (!question) throw new Error("Ask question must not be empty.");

  const context = trimOptional(params.context);
  const options = params.options.map(normalizeOption);
  if (options.length === 0) throw new Error("Ask needs at least one option.");

  const labels = new Set<string>();
  for (const option of options) {
    if (labels.has(option.label)) throw new Error(`Ask options contain duplicate label: ${option.label}.`);
    labels.add(option.label);
  }

  return {
    question,
    ...(context === undefined ? {} : { context }),
    options,
    allowMultiple: params.allowMultiple ?? false,
    allowFreeform: params.allowFreeform ?? true,
    ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
  };
}

export function parseAskReplayDetails(value: unknown): AskReplayDetails | undefined {
  return Check(AskReplayDetailsSchema, value) ? value : undefined;
}

export function answerMatchesAsk(answer: AskAnswer, ask: Ask): boolean {
  if (answer.selections.length > 1 && !ask.allowMultiple) return false;
  if (answer.freeform !== undefined && !ask.allowFreeform) return false;

  const selected = new Set<number>();
  for (const selection of answer.selections) {
    if (selection.option >= ask.options.length || selected.has(selection.option)) return false;
    selected.add(selection.option);
  }
  return true;
}

export function formatAskAnswer(ask: Ask, answer: AskAnswer): string {
  const lines = answer.selections.map((selection) => {
    const option = ask.options[selection.option]!;
    const description = option.description ? ` — ${option.description}` : "";
    const comment = selection.comment ? ` (${selection.comment})` : "";
    return `Selected: ${option.label}${description}${comment}`;
  });
  if (answer.freeform) lines.push(`Freeform: ${answer.freeform}`);
  return lines.join("\n") || "No answer provided.";
}

export function buildAskResponse(ask: Ask, details: AskToolDetails): AskResponse {
  if (details.status === "answered") {
    return {
      content: [{ type: "text", text: formatAskAnswer(ask, details.answer) }],
      details,
    };
  }

  const text = {
    unanswered: "The question timed out without an answer.",
    cancelled: "User cancelled the question.",
    ui_unavailable: "Interactive UI is unavailable.",
  }[details.status];
  return { content: [{ type: "text", text }], details };
}

function normalizeOption(option: AskOption): AskOption {
  const label = option.label.trim();
  if (!label) throw new Error("Ask option label must not be empty.");
  const description = trimOptional(option.description);
  const preview = option.preview?.trim() ? option.preview : undefined;
  return {
    label,
    ...(description === undefined ? {} : { description }),
    ...(preview === undefined ? {} : { preview }),
  };
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
