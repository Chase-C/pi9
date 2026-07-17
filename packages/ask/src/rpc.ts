import type { Ask, AskAnswer, AskOption, AskSelection } from "./domain.js";

export interface AskDialogUI {
  select(title: string, options: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
}

const FREEFORM_CHOICE = "Type a response…";

export async function askWithRpc(
  ui: AskDialogUI,
  ask: Ask,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  const prompt = ask.context ? `${ask.context}\n\n${ask.question}` : ask.question;
  if (signal?.aborted) return null;

  return ask.allowMultiple
    ? runMultiSelect(ui, prompt, ask, signal)
    : runSingleSelect(ui, prompt, ask, signal);
}

async function runSingleSelect(
  ui: AskDialogUI,
  prompt: string,
  ask: Ask,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  const choices = ask.options.map((option, index) => `${index + 1}. ${formatOption(option)}`);
  if (ask.allowFreeform) choices.push(`${ask.options.length + 1}. ${FREEFORM_CHOICE}`);

  const selected = await selectDialog(ui, prompt, choices, signal);
  if (selected == null || signal?.aborted) return null;

  const selectedIndex = choices.indexOf(selected);
  if (selectedIndex === -1) return null;
  if (selectedIndex === ask.options.length) {
    const freeform = await readInput(ui, prompt, signal);
    return freeform === null ? null : makeAnswer([], freeform);
  }

  const selections = await collectComments(ui, prompt, ask.options, [selectedIndex], signal);
  return selections === null ? null : makeAnswer(selections);
}

async function runMultiSelect(
  ui: AskDialogUI,
  prompt: string,
  ask: Ask,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  const numberedOptions = ask.options
    .map((option, index) => `${index + 1}. ${formatOption(option)}`)
    .join("\n");
  const selectionPrompt = `${prompt}\n\n${numberedOptions}\n\nEnter option numbers separated by commas:`;
  const rawSelection = await readInput(ui, selectionPrompt, signal);
  if (rawSelection === null) return null;

  const selected = parseSelections(rawSelection, ask.options.length);
  const freeform = ask.allowFreeform
    ? await readInput(ui, `${prompt}\n\nAdditional response (optional):`, signal)
    : undefined;
  if (freeform === null) return null;

  const selections = await collectComments(ui, prompt, ask.options, selected, signal);
  return selections === null ? null : makeAnswer(selections, freeform);
}

function parseSelections(raw: string, optionCount: number): number[] {
  const selected = new Set<number>();
  for (const token of raw.split(",")) {
    const value = token.trim();
    if (!/^\d+$/.test(value)) continue;

    const index = Number(value) - 1;
    if (Number.isSafeInteger(index) && index >= 0 && index < optionCount) selected.add(index);
  }
  return [...selected].sort((a, b) => a - b);
}

async function collectComments(
  ui: AskDialogUI,
  prompt: string,
  options: AskOption[],
  selected: number[],
  signal?: AbortSignal,
): Promise<AskSelection[] | null> {
  const selections: AskSelection[] = selected.map(option => ({ option }));
  for (const selection of selections) {
    const option = options[selection.option]!;
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
