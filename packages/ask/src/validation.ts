import type { AskOption, AskParams, ValidatedAskParams } from "./types.js";

export function validateAskParams(params: AskParams): ValidatedAskParams {
  const question = params.question.trim();
  if (!question) throw new Error("Ask question must not be empty.");

  const context = trimOptional(params.context);
  const options = params.options.map(normalizeOption);
  const labels = new Set<string>();
  for (const option of options) {
    if (labels.has(option.label)) throw new Error(`Ask options contain duplicate label: ${option.label}.`);
    labels.add(option.label);
  }

  const allowFreeform = params.allowFreeform ?? true;
  if (options.length === 0) throw new Error("Ask needs at least one option.");

  return {
    question,
    ...(context === undefined ? {} : { context }),
    options,
    allowMultiple: params.allowMultiple ?? false,
    allowFreeform,
    ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
  };
}

function normalizeOption(option: AskOption): AskOption {
  const label = option.label.trim();
  if (!label) throw new Error("Ask option label must not be empty.");
  const description = trimOptional(option.description);
  const preview = preserveOptional(option.preview);
  return {
    label,
    ...(description === undefined ? {} : { description }),
    ...(preview === undefined ? {} : { preview }),
  };
}

function trimOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function preserveOptional(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}
