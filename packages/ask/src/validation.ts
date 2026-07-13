import type { AskOption, AskParams, ValidatedAskParams } from "./types.js";

export function validateAskParams(params: AskParams): ValidatedAskParams {
  if (params.answered !== undefined) throw new Error("Ask answered is reserved for historical context.");

  const question = params.question.trim();
  if (!question) throw new Error("Ask question must not be empty.");

  const context = trimOptional(params.context);
  const options = (params.options ?? []).map(normalizeOption);
  const labels = new Set<string>();
  for (const option of options) {
    if (labels.has(option.label)) throw new Error(`Ask options contain duplicate label: ${option.label}.`);
    labels.add(option.label);
  }

  const allowFreeform = params.allowFreeform ?? true;
  if (!allowFreeform && options.length === 0) {
    throw new Error("Ask needs at least one option when freeform responses are disabled.");
  }

  return {
    question,
    ...(context === undefined ? {} : { context }),
    options,
    allowMultiple: params.allowMultiple ?? false,
    allowFreeform,
  };
}

function normalizeOption(option: AskOption): AskOption {
  const label = option.label.trim();
  if (!label) throw new Error("Ask option label must not be empty.");
  const description = trimOptional(option.description);
  return { label, ...(description === undefined ? {} : { description }) };
}

function trimOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
