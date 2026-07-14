import {
  ASK_REPLAY_CUSTOM_TYPE,
  parseAskAnswer,
  parseAskReplayDetails,
  validateStoredArgs,
} from "./replay.js";
import type { AskAnswer } from "./types.js";
import type { AskReplayDetails } from "./replay.js";

type RecordValue = Record<string, unknown>;
type AskCall<T> = {
  args: RecordValue;
  message: T;
  standalone: boolean;
};
type ReplayRecord<T> = {
  message: T;
  details?: AskReplayDetails;
};

const ASK_SUMMARY_CUSTOM_TYPE = "ask:summary" as const;

type AskSummaryPayload = {
  type: "ask_response";
  question: string;
  context?: string;
  selectionMode: "single" | "multi";
  answer: Array<RecordValue>;
};

/**
 * Replace completed Ask exchanges with the small custom message that is useful
 * to the model. The session still contains the original protocol messages; the
 * projection must not leave a tool call without its result.
 */
export function rewriteAskContext<T>(messages: readonly T[]): T[] {
  const calls = collectCalls(messages);
  const nativeResults = collectNativeResults(messages);
  const replayRecords = collectReplayRecords(messages);

  const summaries = new Map<T, T>();
  const removals = new Set<T>();
  for (const [toolCallId, call] of calls) {
    if (!call || !call.standalone) continue;

    const results = nativeResults.get(toolCallId) ?? [];
    if (results.length > 1) continue;
    const result = results[0];

    const replays = replayRecords.get(toolCallId) ?? [];
    let answer: AskAnswer | undefined;
    let replay: ReplayRecord<T> | undefined;
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
        if (result.isError === true
          || (result.isError !== undefined && typeof result.isError !== "boolean")) continue;
        const details = parseNativeDetails(result.details);
        if (!details
          || details.question !== call.args.question
          || !answerMatchesCall(details.answer, call.args)) continue;
        answer = details.answer;
      }
    } else if (!replay) {
      // A native Ask is complete only when its result is present. A replay is
      // allowed to be the only completion record because it can be projected
      // after the original result has fallen out of context.
      continue;
    }

    if (!answer) continue;
    const timestamp = replay
      ? timestampOf(replay.message) ?? timestampOf(result) ?? timestampOf(call.message) ?? Date.now()
      : timestampOf(result) ?? timestampOf(call.message) ?? Date.now();
    const summary = makeSummary(call, answer, timestamp);
    summaries.set(call.message, summary as T);
    removals.add(call.message);
    if (result) removals.add(result as T);
    if (replay) removals.add(replay.message);
  }

  const rewritten: T[] = [];
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

function collectCalls<T>(messages: readonly T[]): Map<string, AskCall<T> | undefined> {
  const calls = new Map<string, AskCall<T> | undefined>();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const toolCalls = message.content.filter((block): block is RecordValue => isRecord(block) && block.type === "toolCall");
    for (const block of toolCalls) {
      if (block.name !== "ask" || typeof block.id !== "string") continue;
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

function collectNativeResults<T>(messages: readonly T[]): Map<string, RecordValue[]> {
  const results = new Map<string, RecordValue[]>();
  for (const message of messages) {
    if (!isRecord(message)
      || message.role !== "toolResult"
      || typeof message.toolCallId !== "string") continue;
    const matching = results.get(message.toolCallId) ?? [];
    matching.push(message);
    results.set(message.toolCallId, matching);
  }
  return results;
}

function collectReplayRecords<T>(messages: readonly T[]): Map<string, ReplayRecord<T>[]> {
  const records = new Map<string, ReplayRecord<T>[]>();
  for (const message of messages) {
    if (!isRecord(message)
      || message.role !== "custom"
      || message.customType !== ASK_REPLAY_CUSTOM_TYPE) continue;
    const rawDetails = isRecord(message.details) && typeof message.details.toolCallId === "string"
      ? message.details.toolCallId
      : undefined;
    const details = parseReplayMessage(message);
    const toolCallId = details?.toolCallId ?? rawDetails;
    if (toolCallId === undefined) continue;
    const matching = records.get(toolCallId) ?? [];
    matching.push({ message, ...(details ? { details } : {}) });
    records.set(toolCallId, matching);
  }
  return records;
}

function parseReplayMessage(value: unknown): AskReplayDetails | undefined {
  if (!isRecord(value)
    || value.role !== "custom"
    || value.customType !== ASK_REPLAY_CUSTOM_TYPE) return undefined;
  return parseAskReplayDetails(value.details);
}

function parseNativeDetails(value: unknown): { question: string; answer: AskAnswer } | undefined {
  if (!isRecord(value) || value.status !== "answered" || typeof value.question !== "string") return undefined;
  const answer = parseAskAnswer(value.answer);
  if (!answer || Object.keys(value).some(key => !["status", "question", "answer"].includes(key))) return undefined;
  return { question: value.question, answer };
}

function matchesCall(replay: AskReplayDetails, args: RecordValue): boolean {
  return replay.question === args.question
    && replay.context === args.context
    && replay.allowMultiple === (args.allowMultiple === true);
}

function answerMatchesCall(answer: AskAnswer, args: RecordValue): boolean {
  if (answer.selections.length > 1 && args.allowMultiple !== true) return false;
  if (answer.freeform !== undefined && args.allowFreeform !== true) return false;

  const labels = new Set(
    Array.isArray(args.options)
      ? args.options.filter(isRecord).map(option => option.label).filter((label): label is string => typeof label === "string")
      : [],
  );
  const selected = new Set<string>();
  for (const selection of answer.selections) {
    if (!labels.has(selection.label) || selected.has(selection.label)) return false;
    selected.add(selection.label);
  }
  return true;
}

function makeSummary<T>(call: AskCall<T>, answer: AskAnswer, timestamp: number): RecordValue {
  const selected = answer.selections.map(selection => selectedOption(selection, call.args));
  const payload: AskSummaryPayload = {
    type: "ask_response",
    question: call.args.question as string,
    ...(typeof call.args.context === "string" ? { context: call.args.context } : {}),
    selectionMode: call.args.allowMultiple === true ? "multi" : "single",
    answer: [
      ...selected,
      ...(answer.freeform !== undefined ? [{ freeform: answer.freeform }] : []),
    ],
  };
  return {
    role: "custom",
    customType: ASK_SUMMARY_CUSTOM_TYPE,
    display: false,
    content: JSON.stringify(payload),
    timestamp,
  };
}

function selectedOption(selection: AskAnswer["selections"][number], args: RecordValue): RecordValue {
  const original = Array.isArray(args.options)
    ? args.options.find(option => isRecord(option) && option.label === selection.label)
    : undefined;
  const description = selection.description
    ?? (isRecord(original) && typeof original.description === "string" ? original.description : undefined);
  return {
    label: selection.label,
    ...(description !== undefined ? { description } : {}),
    ...(selection.comment !== undefined ? { comment: selection.comment } : {}),
  };
}

function timestampOf(value: unknown): number | undefined {
  return isRecord(value) && typeof value.timestamp === "number" ? value.timestamp : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
