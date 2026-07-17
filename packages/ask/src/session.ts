import type {
  ContextEvent,
  SessionEntry,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import {
  AskAnsweredDetailsSchema,
  AskParamsSchema,
  answerMatchesAsk,
  formatAskAnswer,
  normalizeAsk,
  parseAskReplayDetails,
  type Ask,
  type AskAnswer,
  type AskParams,
  type AskReplayDetails,
} from "./domain.js";

export const ASK_REPLAY_CUSTOM_TYPE = "ask:reanswer" as const;
const ASK_SUMMARY_CUSTOM_TYPE = "ask:summary" as const;

type AgentMessage = ContextEvent["messages"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type CustomMessage = Extract<AgentMessage, { role: "custom" }>;

type AskCall = {
  ask: Ask;
  message: AssistantMessage;
};

type ReplayRecord = {
  message: CustomMessage;
  details?: AskReplayDetails;
};

type AskSummaryPayload = {
  type: "ask_response";
  question: string;
  context?: string;
  selectionMode: "single" | "multi";
  answer: {
    selections: Array<{ label: string; description?: string; comment?: string }>;
    freeform?: string;
  };
};

export type AskReplayMessage = {
  customType: typeof ASK_REPLAY_CUSTOM_TYPE;
  content: string;
  display: false;
  details: AskReplayDetails;
};

export type AskReplayResolution =
  | { status: "resolved"; toolCallId: string; ask: Ask }
  | {
      status: "not-replayable";
      reason: "no-entry" | "not-assistant" | "not-ask" | "multiple-tool-calls" | "mixed-tools" | "invalid-arguments";
    };

export function buildAskReplayMessage(toolCallId: string, ask: Ask, answer: AskAnswer): AskReplayMessage {
  return {
    customType: ASK_REPLAY_CUSTOM_TYPE,
    content: formatAskAnswer(ask, answer),
    display: false,
    details: { toolCallId, answer },
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

  const calls = entry.message.content.filter(item => item.type === "toolCall");
  const askCalls = calls.filter(call => call.name === "ask");
  if (calls.length !== 1) {
    if (askCalls.length > 0 && askCalls.length < calls.length) return rejected("mixed-tools");
    if (askCalls.length > 1) return rejected("multiple-tool-calls");
    return rejected("not-ask");
  }

  const call = calls[0]!;
  if (call.name !== "ask" || (selectedToolCallId !== undefined && call.id !== selectedToolCallId)) {
    return rejected("not-ask");
  }

  const ask = parseStoredAsk(call.arguments);
  if (!ask) return rejected("invalid-arguments");
  return { status: "resolved", toolCallId: call.id, ask };
}

export function parseStoredAsk(value: unknown): Ask | undefined {
  if (!Check(AskParamsSchema, value)) return undefined;
  try {
    return normalizeAsk(value as AskParams);
  } catch {
    return undefined;
  }
}

/** Replace completed standalone Ask exchanges with their decision-focused answer. */
export function rewriteAskContext(messages: readonly AgentMessage[]): AgentMessage[] {
  const calls = collectCalls(messages);
  const nativeResults = collectNativeResults(messages);
  const replayRecords = collectReplayRecords(messages);

  const summaries = new Map<AgentMessage, AgentMessage>();
  const removals = new Set<AgentMessage>();
  for (const [toolCallId, call] of calls) {
    if (!call) continue;

    const results = nativeResults.get(toolCallId) ?? [];
    if (results.length > 1) continue;
    const result = results[0];

    const replays = replayRecords.get(toolCallId) ?? [];
    let answer: AskAnswer | undefined;
    let replay: ReplayRecord | undefined;
    if (replays.length > 0) {
      if (replays.length !== 1) continue;
      const candidate = replays[0]!;
      if (!candidate.details || !answerMatchesAsk(candidate.details.answer, call.ask)) continue;
      replay = candidate;
      answer = candidate.details.answer;
    }

    if (result) {
      if (result.toolName !== "ask") continue;
      if (!replay) {
        if (result.isError) continue;
        const details = parseNativeDetails(result.details);
        if (!details || !answerMatchesAsk(details.answer, call.ask)) continue;
        answer = details.answer;
      }
    } else if (!replay) {
      continue;
    }

    if (!answer) continue;
    const timestamp = replay ? replay.message.timestamp : result!.timestamp;
    summaries.set(call.message, makeSummary(call, answer, timestamp));
    removals.add(call.message);
    if (result) removals.add(result);
    if (replay) removals.add(replay.message);
  }

  return messages.flatMap((message) => {
    const summary = summaries.get(message);
    if (summary) return [summary];
    return removals.has(message) ? [] : [message];
  });
}

function collectCalls(messages: readonly AgentMessage[]): Map<string, AskCall | undefined> {
  const calls = new Map<string, AskCall | undefined>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const toolCalls = message.content.filter(block => block.type === "toolCall");
    for (const block of toolCalls) {
      if (block.name !== "ask") continue;
      const ask = toolCalls.length === 1 ? parseStoredAsk(block.arguments) : undefined;
      const call = ask ? { ask, message } : undefined;
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
    const rawToolCallId = isRecord(message.details) && typeof message.details.toolCallId === "string"
      ? message.details.toolCallId
      : undefined;
    const details = parseAskReplayDetails(message.details);
    const toolCallId = details?.toolCallId ?? rawToolCallId;
    if (toolCallId === undefined) continue;
    const matching = records.get(toolCallId) ?? [];
    matching.push({ message, ...(details ? { details } : {}) });
    records.set(toolCallId, matching);
  }
  return records;
}

function parseNativeDetails(value: unknown): { status: "answered"; answer: AskAnswer } | undefined {
  return Check(AskAnsweredDetailsSchema, value) ? value : undefined;
}

function makeSummary(call: AskCall, answer: AskAnswer, timestamp: number): AgentMessage {
  const payload: AskSummaryPayload = {
    type: "ask_response",
    question: call.ask.question,
    ...(call.ask.context !== undefined ? { context: call.ask.context } : {}),
    selectionMode: call.ask.allowMultiple ? "multi" : "single",
    answer: {
      selections: answer.selections.map((selection) => {
        const option = call.ask.options[selection.option]!;
        return {
          label: option.label,
          ...(option.description !== undefined ? { description: option.description } : {}),
          ...(selection.comment !== undefined ? { comment: selection.comment } : {}),
        };
      }),
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

function rejected(reason: Exclude<AskReplayResolution, { status: "resolved" }>["reason"]): AskReplayResolution {
  return { status: "not-replayable", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
