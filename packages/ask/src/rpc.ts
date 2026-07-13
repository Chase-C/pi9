import type { AskAnswer, AskOption, AskParams } from "./types.js";

export interface AskDialogUI {
  select(title: string, options: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
}

type AskSelection = AskAnswer["selections"][number];

const FREEFORM_CHOICE = "Type a response…";

export async function askWithRpc(
  ui: AskDialogUI,
  params: AskParams,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  const options = params.options ?? [];
  const allowFreeform = params.allowFreeform !== false;
  const prompt = params.context ? `${params.context}\n\n${params.question}` : params.question;

  if (options.length === 0 && !allowFreeform) {
    throw new Error("The ask dialog needs at least one option when freeform responses are disabled.");
  }
  if (signal?.aborted) return null;

  return params.allowMultiple === true
    ? runMultiSelect(ui, prompt, options, allowFreeform, signal)
    : runSingleSelect(ui, prompt, options, allowFreeform, signal);
}

async function runSingleSelect(
  ui: AskDialogUI,
  prompt: string,
  options: AskOption[],
  allowFreeform: boolean,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  const choices = options.map((option, index) => `${index + 1}. ${formatOption(option)}`);
  if (allowFreeform) choices.push(`${options.length + 1}. ${FREEFORM_CHOICE}`);

  const selected = await selectDialog(ui, prompt, choices, signal);
  if (selected == null || signal?.aborted) return null;

  const selectedIndex = choices.indexOf(selected);
  if (selectedIndex === -1) return null;
  if (selectedIndex === options.length) {
    const freeform = await readInput(ui, prompt, signal);
    return freeform === null ? null : makeAnswer([], freeform);
  }

  const selectedOption = options[selectedIndex];
  if (!selectedOption) return null;
  const selections = await collectComments(ui, prompt, [selectedOption], signal);
  return selections === null ? null : makeAnswer(selections);
}

async function runMultiSelect(
  ui: AskDialogUI,
  prompt: string,
  options: AskOption[],
  allowFreeform: boolean,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  if (options.length === 0) {
    const freeform = await readInput(ui, prompt, signal);
    return freeform === null ? null : makeAnswer([], freeform);
  }

  const numberedOptions = options
    .map((option, index) => `${index + 1}. ${formatOption(option)}`)
    .join("\n");
  const selectionPrompt = `${prompt}\n\n${numberedOptions}\n\nEnter option numbers separated by commas:`;
  const rawSelection = await readInput(ui, selectionPrompt, signal);
  if (rawSelection === null) return null;

  const selectedOptions = parseSelections(rawSelection, options);
  const freeform = allowFreeform
    ? await readInput(ui, `${prompt}\n\nAdditional response (optional):`, signal)
    : undefined;
  if (freeform === null) return null;

  const selections = await collectComments(ui, prompt, selectedOptions, signal);
  return selections === null ? null : makeAnswer(selections, freeform);
}

function parseSelections(raw: string, options: AskOption[]): AskOption[] {
  const indices = new Set<number>();
  for (const token of raw.split(",")) {
    const value = token.trim();
    if (!/^\d+$/.test(value)) continue;

    const index = Number(value) - 1;
    if (Number.isSafeInteger(index) && index >= 0 && index < options.length) indices.add(index);
  }
  return options.filter((_option, index) => indices.has(index));
}

async function collectComments(
  ui: AskDialogUI,
  prompt: string,
  options: AskOption[],
  signal?: AbortSignal,
): Promise<AskSelection[] | null> {
  const selections: AskSelection[] = options.map(toSelection);
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const selection = selections[index];
    if (!option || !selection) continue;

    const comment = await readInput(ui, `${prompt}\n\nComment for \"${option.label}\" (optional):`, signal);
    if (comment === null) return null;
    if (comment) selection.comment = comment;
  }
  return selections;
}

async function readInput(ui: AskDialogUI, title: string, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;
  const value = await inputDialog(ui, title, signal);
  if (value == null || signal?.aborted) return null;
  return value.trim();
}

function toSelection(option: AskOption): AskSelection {
  const selection: AskSelection = { label: option.label };
  if (option.description !== undefined) selection.description = option.description;
  return selection;
}

function makeAnswer(selections: AskSelection[], freeform?: string): AskAnswer {
  return freeform ? { selections, freeform } : { selections };
}

function formatOption(option: AskOption): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

function selectDialog(ui: AskDialogUI, title: string, options: string[], signal?: AbortSignal) {
  return signal ? ui.select(title, options, { signal }) : ui.select(title, options);
}

function inputDialog(ui: AskDialogUI, title: string, signal?: AbortSignal) {
  return signal ? ui.input(title, undefined, { signal }) : ui.input(title);
}
