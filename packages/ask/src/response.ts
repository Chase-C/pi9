import type { AskAnswer, AskResponse, AskToolDetails } from "./types.js";

export function formatAskAnswer(answer: AskAnswer): string {
  const lines = answer.selections.map((selection) => {
    const description = selection.description ? ` — ${selection.description}` : "";
    const comment = selection.comment ? ` (${selection.comment})` : "";
    return `Selected: ${selection.label}${description}${comment}`;
  });
  if (answer.freeform) lines.push(`Freeform: ${answer.freeform}`);
  return lines.join("\n") || "No answer provided.";
}

export function buildAnsweredResponse(question: string, answer: AskAnswer): AskResponse {
  return buildResponse(formatAskAnswer(answer), { status: "answered", question, answer });
}

export function buildUnansweredResponse(question: string): AskResponse {
  return buildResponse("The question timed out without an answer.", { status: "unanswered", question });
}

export function buildCancelledResponse(question: string): AskResponse {
  return buildResponse("User cancelled the question.", { status: "cancelled", question });
}

export function buildUiUnavailableResponse(question: string): AskResponse {
  return buildResponse("Interactive UI is unavailable.", { status: "ui_unavailable", question });
}

function buildResponse(text: string, details: AskToolDetails): AskResponse {
  return { content: [{ type: "text", text }], details };
}
