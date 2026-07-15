import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import { AskAnsweredDetailsSchema } from "./schema.js";
import {
  ASK_REPLAY_CUSTOM_TYPE,
  parseAskReplayDetails,
  validateStoredArgs,
} from "./replay.js";
import type { AskAnswer, AskReplayDetails, ValidatedAskParams } from "./types.js";

type AgentMessage = ContextEvent["messages"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type CustomMessage = Extract<AgentMessage, { role: "custom" }>;
type AskCall = {
  args: ValidatedAskParams;
  message: AssistantMessage;
  standalone: boolean;
};
type ReplayRecord = {
  message: CustomMessage;
  details?: AskReplayDetails;
};

const ASK_SUMMARY_CUSTOM_TYPE = "ask:summary" as const;

type AskSummaryPayload = {
  type: "ask_response";
  question: string;
  context?: string;
  selectionMode: "single" | "multi";
  answer: AskAnswer;
};

/**
 * Replace completed Ask exchanges with the small custom message that is useful
 * to the model. The session still contains the original protocol messages; the
 * projection must not leave a tool call without its result.
 */
export function rewriteAskContext(messages: readonly AgentMessage[]): AgentMessage[] {
  const calls = collectCalls(messages);
  const nativeResults = collectNativeResults(messages);
  const replayRecords = collectReplayRecords(messages);

  const summaries = new Map<AgentMessage, AgentMessage>();
  const removals = new Set<AgentMessage>();
  for (const [toolCallId, call] of calls) {
    if (!call || !call.standalone) continue;

    const results = nativeResults.get(toolCallId) ?? [];
    if (results.length > 1) continue;
    const result = results[0];

    const replays = replayRecords.get(toolCallId) ?? [];
    let answer: AskAnswer | undefined;
    let replay: ReplayRecord | undefined;
    if (replays.length > 0) {
      // A replay is a revision only when it is the one well-formed marker for
      // this call. In particular, do not hide malformed or duplicate markers.
      if (replays.length !== 1) continue;
      const candidate = replays[0]!;
      if (!candidate.details
        || !matchesCall(candidate.details, call.args)
        || !answerMatchesCall(candidate.details.answer, call.args)) continue;
      replay = candidate;
      answer = candidate.details.answer;
    }

    if (result) {
      if (result.toolName !== "ask") continue;
      // A valid replay is the latest answer and takes precedence regardless
      // of whether the earlier native attempt completed successfully.
      if (!replay) {
        if (result.isError) continue;
        const details = parseNativeDetails(result.details);
        if (!details
          || details.question !== call.args.question
          || !answerMatchesCall(details.answer, call.args)) continue;
        answer = details.answer;
      }
    } else if (!replay) {
      continue;
    }

    if (!answer) continue;
    const timestamp = replay ? replay.message.timestamp : result!.timestamp;
    const summary = makeSummary(call, answer, timestamp);
    summaries.set(call.message, summary);
    removals.add(call.message);
    if (result) removals.add(result);
    if (replay) removals.add(replay.message);
  }

  const rewritten: AgentMessage[] = [];
  for (const message of messages) {
    const summary = summaries.get(message);
    if (summary) {
      rewritten.push(summary);
      continue;
    }
    if (!removals.has(message)) rewritten.push(message);
  }
  return rewritten;
}

function collectCalls(messages: readonly AgentMessage[]): Map<string, AskCall | undefined> {
  const calls = new Map<string, AskCall | undefined>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const toolCalls = message.content.filter(block => block.type === "toolCall");
    for (const block of toolCalls) {
      if (block.name !== "ask") continue;
      const args = validateStoredArgs(block.arguments);
      const call = args
        ? { args, message, standalone: toolCalls.length === 1 }
        : undefined;
      // Keep an invalid entry as ambiguous too. A later valid call with the
      // same ID must not make an otherwise malformed exchange transformable.
      calls.set(block.id, calls.has(block.id) ? undefined : call);
    }
  }
  return calls;
}

function collectNativeResults(messages: readonly AgentMessage[]): Map<string, ToolResultMessage[]> {
  const results = new Map<string, ToolResultMessage[]>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const matching = results.get(message.toolCallId) ?? [];
    matching.push(message);
    results.set(message.toolCallId, matching);
  }
  return results;
}

function collectReplayRecords(messages: readonly AgentMessage[]): Map<string, ReplayRecord[]> {
  const records = new Map<string, ReplayRecord[]>();
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== ASK_REPLAY_CUSTOM_TYPE) continue;
    const rawDetails = isRecord(message.details) && typeof message.details.toolCallId === "string"
      ? message.details.toolCallId
      : undefined;
    const details = parseAskReplayDetails(message.details);
    const toolCallId = details?.toolCallId ?? rawDetails;
    if (toolCallId === undefined) continue;
    const matching = records.get(toolCallId) ?? [];
    matching.push({ message, ...(details ? { details } : {}) });
    records.set(toolCallId, matching);
  }
  return records;
}

function parseNativeDetails(value: unknown): { question: string; answer: AskAnswer } | undefined {
  return Check(AskAnsweredDetailsSchema, value) ? value : undefined;
}

function matchesCall(replay: AskReplayDetails, args: ValidatedAskParams): boolean {
  return replay.question === args.question
    && replay.context === args.context
    && replay.allowMultiple === args.allowMultiple;
}

function answerMatchesCall(answer: AskAnswer, args: ValidatedAskParams): boolean {
  if (answer.selections.length > 1 && !args.allowMultiple) return false;
  if (answer.freeform !== undefined && !args.allowFreeform) return false;

  const labels = new Set(args.options.map(option => option.label));
  const selected = new Set<string>();
  for (const selection of answer.selections) {
    if (!labels.has(selection.label) || selected.has(selection.label)) return false;
    selected.add(selection.label);
  }
  return true;
}

function makeSummary(call: AskCall, answer: AskAnswer, timestamp: number): AgentMessage {
  const payload: AskSummaryPayload = {
    type: "ask_response",
    question: call.args.question,
    ...(call.args.context !== undefined ? { context: call.args.context } : {}),
    selectionMode: call.args.allowMultiple ? "multi" : "single",
    answer: {
      selections: answer.selections.map(selection => selectedOption(selection, call.args)),
      ...(answer.freeform !== undefined ? { freeform: answer.freeform } : {}),
    },
  };
  return {
    role: "custom",
    customType: ASK_SUMMARY_CUSTOM_TYPE,
    display: false,
    content: JSON.stringify(payload),
    timestamp,
  };
}

function selectedOption(selection: AskAnswer["selections"][number], args: ValidatedAskParams): AskAnswer["selections"][number] {
  const original = args.options.find(option => option.label === selection.label);
  const description = selection.description ?? original?.description;
  return {
    label: selection.label,
    ...(description !== undefined ? { description } : {}),
    ...(selection.comment !== undefined ? { comment: selection.comment } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
