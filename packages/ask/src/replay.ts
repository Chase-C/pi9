import type { SessionEntry, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import { AskAnswerSchema, AskParamsSchema, AskReplayDetailsSchema } from "./schema.js";
import { formatAskAnswer } from "./response.js";
import type { AskAnswer, AskParams, AskReplayDetails, ValidatedAskParams } from "./types.js";
import { validateAskParams } from "./validation.js";

export const ASK_REPLAY_CUSTOM_TYPE = "ask:reanswer" as const;

export type { AskReplayDetails } from "./types.js";

export type AskReplayMessage = {
  customType: typeof ASK_REPLAY_CUSTOM_TYPE;
  content: string;
  display: false;
  details: AskReplayDetails;
};

/** Parse the canonical answer shape used by native results and replay details. */
export function parseAskAnswer(value: unknown): AskAnswer | undefined {
  return Check(AskAnswerSchema, value) ? value : undefined;
}

/** Parse canonical replay details, without validating the containing message. */
export function parseAskReplayDetails(value: unknown): AskReplayDetails | undefined {
  return Check(AskReplayDetailsSchema, value) ? value : undefined;
}

export type AskReplayResolution =
  | { status: "resolved"; toolCallId: string; params: ValidatedAskParams }
  | {
      status: "not-replayable";
      reason: "no-entry" | "not-assistant" | "not-ask" | "multiple-tool-calls" | "mixed-tools" | "invalid-arguments";
    };

export function buildAskReplayMessage(toolCallId: string, params: ValidatedAskParams, answer: AskAnswer): AskReplayMessage {
  return {
    customType: ASK_REPLAY_CUSTOM_TYPE,
    content: formatAskAnswer(answer).replaceAll("\n", " · "),
    display: false,
    details: {
      toolCallId,
      question: params.question,
      ...(params.context !== undefined ? { context: params.context } : {}),
      allowMultiple: params.allowMultiple,
      answer,
    },
  };
}

/** Resolve only the selected leaf, or its immediate parent when Pi created a branch summary. */
export function resolveAskReplayTarget(
  event: Pick<SessionTreeEvent, "newLeafId" | "summaryEntry">,
  getEntry: (id: string) => SessionEntry | undefined | null,
): AskReplayResolution {
  if (!event.newLeafId) return rejected("no-entry");

  let entry = getEntry(event.newLeafId);
  const summary = event.summaryEntry?.id === event.newLeafId
    ? event.summaryEntry
    : entry?.type === "branch_summary" ? entry : undefined;
  if (summary) entry = summary.parentId ? getEntry(summary.parentId) : undefined;
  if (!entry) return rejected("no-entry");

  let selectedToolCallId: string | undefined;
  if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ask") {
    selectedToolCallId = entry.message.toolCallId;
    entry = entry.parentId ? getEntry(entry.parentId) : undefined;
  }
  if (!entry) return rejected("no-entry");
  if (entry.type !== "message" || entry.message.role !== "assistant") return rejected("not-assistant");

  const calls = entry.message.content.filter((item) => item.type === "toolCall");
  const askCalls = calls.filter((call) => call.name === "ask");
  if (calls.length !== 1) {
    if (askCalls.length > 0 && askCalls.length < calls.length) return rejected("mixed-tools");
    if (askCalls.length > 1) return rejected("multiple-tool-calls");
    return rejected("not-ask");
  }
  const call = calls[0];
  if (call.name !== "ask" || (selectedToolCallId !== undefined && call.id !== selectedToolCallId)) return rejected("not-ask");

  const params = validateStoredArgs(call.arguments);
  if (!params) return rejected("invalid-arguments");
  return { status: "resolved", toolCallId: call.id, params };
}

export function validateStoredArgs(value: unknown): ValidatedAskParams | undefined {
  if (!Check(AskParamsSchema, value)) return undefined;
  try {
    return validateAskParams(value as AskParams);
  } catch {
    return undefined;
  }
}

function rejected(reason: Exclude<AskReplayResolution, { status: "resolved" }>["reason"]): AskReplayResolution {
  return { status: "not-replayable", reason };
}
