import type { MessageRenderOptions, MessageRenderer } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AskAnswer } from "./types.js";

/** The answer data needed to render an ask:reanswer message. */
export interface AskReanswerDetails {
  question: string;
  context?: string;
  answer: AskAnswer;
}

interface RenderMessage {
  content?: unknown;
  details?: unknown;
}

type Selection = AskReanswerDetails["answer"]["selections"][number];
type ParsedDetails = AskReanswerDetails;
type RecordValue = Record<string, unknown>;

/**
 * Render a completed ask replay for registration with
 * `pi.registerMessageRenderer("ask:reanswer", renderAskReanswerMessage)`.
 *
 * The renderer deliberately returns a Text component rather than pre-wrapped
 * strings. Text performs wrapping using terminal column widths, including
 * when the theme has added ANSI styling to the label.
 */
export const renderAskReanswerMessage = (
  message: RenderMessage,
  options: Pick<MessageRenderOptions, "expanded">,
  theme: Pick<Theme, "fg"> | undefined,
): Text => renderMessage(message, options, theme);

// Keep the exported function's concrete Text return type while checking the
// exact signature expected by ExtensionAPI.registerMessageRenderer.
const messageRendererCompatibilityCheck: MessageRenderer = renderAskReanswerMessage;
void messageRendererCompatibilityCheck;

/** Alias which describes the text shown by this renderer. */
export const renderRevisedAnswerMessage = renderAskReanswerMessage;

/** Short alias for callers that register the renderer directly. */
export const renderAskReanswer = renderAskReanswerMessage;

/** Alias retained for integrations that call replay messages "replay". */
export const renderAskReplayMessage = renderAskReanswerMessage;

export default renderAskReanswerMessage;

function renderMessage(
  message: RenderMessage,
  options: Pick<MessageRenderOptions, "expanded">,
  theme: Pick<Theme, "fg"> | undefined,
): Text {
  const details = parseDetails(message.details);
  const content = details
    ? formatDetails(details, options.expanded, theme)
    : textualContent(message.content);
  return new Text(content, 0, 0);
}

function formatDetails(details: ParsedDetails, expanded: boolean, theme: Pick<Theme, "fg"> | undefined): string {
  const label = colorLabel("Revised answer", theme);
  const selections = details.answer.selections;
  const freeform = details.answer.freeform;

  if (!expanded) {
    const lines: string[] = [label];
    if (selections.length > 0) lines.push(`Selected: ${selections.map(selection => selection.label).join(", ")}`);
    if (freeform) lines.push(`Freeform: ${freeform}`);
    if (selections.length === 0 && !freeform) lines.push("No answer provided.");
    return lines.join(" · ");
  }

  const lines: string[] = [label, `Question: ${details.question}`];
  if (details.context) lines.push(`Context: ${details.context}`);
  if (selections.length > 0) {
    lines.push("Selections:");
    for (const selection of selections) {
      let line = `- ${selection.label}`;
      if (selection.description) line += ` — ${selection.description}`;
      if (selection.comment) line += ` (${selection.comment})`;
      lines.push(line);
    }
  }
  if (freeform) lines.push(`Freeform: ${freeform}`);
  if (selections.length === 0 && !freeform) lines.push("No answer provided.");
  return lines.join("\n");
}

function parseDetails(value: unknown): ParsedDetails | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status !== undefined && value.status !== "answered") return undefined;

  const params = value.params === undefined ? undefined : readParams(value.params);
  if (value.params !== undefined && !params) return undefined;
  const directOptions = value.options === undefined ? undefined : readOptions(value.options);
  if (value.options !== undefined && !directOptions) return undefined;

  if (value.question !== undefined && typeof value.question !== "string") return undefined;
  const question = typeof value.question === "string" ? value.question : params?.question;
  const context = value.context !== undefined
    ? typeof value.context === "string" ? value.context : undefined
    : params?.context;
  if (question === undefined || (value.context !== undefined && typeof value.context !== "string")) return undefined;

  const answer = readAnswer(value.answer, params?.options ?? directOptions);
  if (!answer) return undefined;
  return {
    question,
    ...(context !== undefined ? { context } : {}),
    answer,
  };
}

function readParams(value: unknown): {
  question: string;
  context?: string;
  options?: ReadonlyArray<{ label: string; description?: string }>;
} | undefined {
  if (!isRecord(value) || typeof value.question !== "string") return undefined;
  if (value.context !== undefined && typeof value.context !== "string") return undefined;

  const options = value.options === undefined ? undefined : readOptions(value.options);
  if (value.options !== undefined && !options) return undefined;
  return {
    question: value.question,
    ...(value.context !== undefined ? { context: value.context } : {}),
    ...(options !== undefined ? { options } : {}),
  };
}

function readOptions(value: unknown): ReadonlyArray<{ label: string; description?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: Array<{ label: string; description?: string }> = [];
  for (const option of value) {
    if (!isRecord(option) || typeof option.label !== "string") return undefined;
    if (option.description !== undefined && typeof option.description !== "string") return undefined;
    options.push({
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
    });
  }
  return options;
}

function readAnswer(
  value: unknown,
  options: ReadonlyArray<{ label: string; description?: string }> | undefined,
): AskReanswerDetails["answer"] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.cancelled !== undefined && value.cancelled !== false) return undefined;

  const rawSelections = value.selections !== undefined ? value.selections : value.selectedOptions;
  if (!Array.isArray(rawSelections)) return undefined;
  const selections: Selection[] = [];
  for (const rawSelection of rawSelections) {
    if (!isRecord(rawSelection) || typeof rawSelection.label !== "string") return undefined;
    if (rawSelection.description !== undefined && typeof rawSelection.description !== "string") return undefined;
    if (rawSelection.comment !== undefined && typeof rawSelection.comment !== "string") return undefined;

    const source = options?.find(option => option.label === rawSelection.label);
    selections.push({
      label: rawSelection.label,
      ...(rawSelection.description !== undefined
        ? { description: rawSelection.description }
        : source?.description !== undefined ? { description: source.description } : {}),
      ...(rawSelection.comment !== undefined ? { comment: rawSelection.comment } : {}),
    });
  }

  const freeform = value.freeform !== undefined ? value.freeform : value.freeformAnswer;
  if (freeform !== undefined && typeof freeform !== "string") return undefined;
  return {
    selections,
    ...(freeform !== undefined ? { freeform } : {}),
  };
}

function textualContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter(item => item.type === "text" && typeof item.text === "string")
    .map(item => item.text as string)
    .join("\n");
}

function colorLabel(label: string, theme: Pick<Theme, "fg"> | undefined): string {
  return typeof theme?.fg === "function" ? theme.fg("customMessageLabel", label) : label;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
