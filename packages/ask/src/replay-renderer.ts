import type { MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { parseAskReplayDetails, type AskReplayDetails } from "./replay.js";

interface RenderMessage {
  content?: unknown;
  details?: unknown;
}

type Selection = AskReplayDetails["answer"]["selections"][number];
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

function renderMessage(
  message: RenderMessage,
  options: Pick<MessageRenderOptions, "expanded">,
  theme: Pick<Theme, "fg"> | undefined,
): Text {
  const details = parseAskReplayDetails(message.details);
  const content = details
    ? formatDetails(details, options.expanded, theme)
    : textualContent(message.content);
  return new Text(content, 0, 0);
}

function formatDetails(details: AskReplayDetails, expanded: boolean, theme: Pick<Theme, "fg"> | undefined): string {
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
