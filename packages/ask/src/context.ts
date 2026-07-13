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
  id: string;
  block: RecordValue;
  args: RecordValue;
  message: T;
  standalone: boolean;
};

export function rewriteAskContext<T>(messages: readonly T[]): T[] {
  const copied = structuredClone(messages) as T[];
  const calls = new Map<string, AskCall<T> | undefined>();
  for (const message of copied) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const toolCalls = message.content.filter((block): block is RecordValue => isRecord(block) && block.type === "toolCall");
    for (const block of toolCalls) {
      if (block.name !== "ask") continue;
      const args = validateStoredArgs(block.arguments);
      if (typeof block.id !== "string" || !args) continue;
      const call = { id: block.id, block, args, message, standalone: toolCalls.length === 1 };
      calls.set(block.id, calls.has(block.id) ? undefined : call);
    }
  }

  const nativeResults = new Map<string, RecordValue[]>();
  for (const message of copied) {
    if (!isRecord(message)
      || message.role !== "toolResult"
      || message.toolName !== "ask"
      || typeof message.toolCallId !== "string") continue;
    const results = nativeResults.get(message.toolCallId) ?? [];
    results.push(message);
    nativeResults.set(message.toolCallId, results);
  }

  const replayCandidates = new Map<string, Array<{ message: T; details: AskReplayDetails; timestamp: number }>>();
  for (const message of copied) {
    const replay = parseReplayMessage(message);
    if (!replay) continue;
    const call = calls.get(replay.toolCallId);
    if (!call || !call.standalone || !matchesCall(replay, call.args) || !answerMatchesCall(replay.answer, call.args)) continue;
    const candidates = replayCandidates.get(replay.toolCallId) ?? [];
    candidates.push({
      message,
      details: replay,
      timestamp: isRecord(message) && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    });
    replayCandidates.set(replay.toolCallId, candidates);
  }

  const removals = new Set<T>();
  const insertions = new Map<T, T>();
  const revisedResultIds = new Set<string>();
  for (const [toolCallId, candidates] of replayCandidates) {
    if (candidates.length !== 1) continue;
    const call = calls.get(toolCallId)!;
    const candidate = candidates[0]!;
    const existing = nativeResults.get(toolCallId) ?? [];
    if (existing.length > 1) continue;

    const details = {
      status: "answered" as const,
      question: candidate.details.question,
      answer: candidate.details.answer,
    };
    if (existing.length === 1) {
      const result = existing[0]!;
      rewritePair(call, result, candidate.details.answer);
      result.details = details;
      result.isError = false;
    } else {
      const result: RecordValue = {
        role: "toolResult",
        toolCallId,
        toolName: "ask",
        content: [{ type: "text", text: summarize(candidate.details.answer) }],
        details,
        isError: false,
        timestamp: candidate.timestamp,
      };
      rewritePair(call, result, candidate.details.answer);
      insertions.set(call.message, result as T);
    }
    revisedResultIds.add(toolCallId);
    removals.add(candidate.message);
  }

  for (const [toolCallId, results] of nativeResults) {
    if (revisedResultIds.has(toolCallId) || results.length > 1) continue;
    const call = calls.get(toolCallId);
    if (!call) continue;
    const result = results[0]!;
    if (result.isError === true) continue;
    const details = parseNativeDetails(result.details);
    if (details && answerMatchesCall(details.answer, call.args)) rewritePair(call, result, details.answer);
  }

  const rewritten: T[] = [];
  for (const message of copied) {
    if (removals.has(message)) continue;
    rewritten.push(message);
    const insertion = insertions.get(message);
    if (insertion) rewritten.push(insertion);
  }
  return rewritten;
}

function parseReplayMessage(value: unknown): AskReplayDetails | undefined {
  if (!isRecord(value) || value.customType !== ASK_REPLAY_CUSTOM_TYPE) return undefined;
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

function rewritePair(
  call: { block: RecordValue; args: RecordValue },
  result: RecordValue,
  answer: AskAnswer,
): void {
  const selections = answer.selections.map(selection => selectedOption(selection, call.args));
  const args: RecordValue = { question: call.args.question };
  if (typeof call.args.context === "string") args.context = call.args.context;
  if (Array.isArray(call.args.options) && call.args.options.length > 0) args.answered = true;
  if (answer.selections.length > 1 && call.args.allowMultiple === true) args.allowMultiple = true;
  call.block.arguments = args;
  result.content = [{ type: "text", text: summarize({ ...answer, selections }) }];
}

function selectedOption(selection: AskAnswer["selections"][number], args: RecordValue): AskAnswer["selections"][number] {
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

function summarize(answer: AskAnswer): string {
  const selected = answer.selections.map(({ label, description, comment }) => {
    const described = description ? `${label} — ${description}` : label;
    return comment ? `${described} (${comment})` : described;
  });
  const parts: string[] = [];
  if (selected.length > 0) parts.push(`Selected: ${selected.join(", ")}`);
  if (answer.freeform !== undefined) parts.push(`response: ${answer.freeform}`);
  return parts.length > 0 ? parts.join("; ") : "No answer provided.";
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
