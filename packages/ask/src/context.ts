import { validateStoredArgs } from "./replay.js";

type RecordValue = Record<string, unknown>;

/**
 * Projects completed ask interactions into a smaller, model-facing form.
 *
 * The input is never mutated. A pair is rewritten only when both its call and
 * successful structured result can be identified unambiguously.
 */
export function rewriteAskContext<T>(messages: readonly T[]): T[] {
  const copied = structuredClone(messages) as T[];
  type AskCall = { id: string; block: RecordValue; args: RecordValue; message: T; standalone: boolean };
  const discoveredCalls: AskCall[] = [];
  const nativeResultIds = new Set<string>();

  for (const message of copied) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const toolCalls = message.content.filter(block => isRecord(block) && block.type === "toolCall");
    for (const block of toolCalls) {
      if (block.name !== "ask") continue;
      const args = validateStoredArgs(block.arguments);
      if (typeof block.id !== "string" || !args) continue;
      discoveredCalls.push({ id: block.id, block, args, message, standalone: toolCalls.length === 1 });
    }
  }

  const idCounts = new Map<string, number>();
  for (const call of discoveredCalls) idCounts.set(call.id, (idCounts.get(call.id) ?? 0) + 1);
  const calls = new Map<string, Omit<AskCall, "id" | "standalone">>();
  const replayCalls = new Map<string, Omit<AskCall, "id" | "standalone">>();
  for (const { id, standalone, ...call } of discoveredCalls) {
    if (idCounts.get(id) !== 1) continue;
    calls.set(id, call);
    if (standalone) replayCalls.set(id, call);
  }

  for (const message of copied) {
    if (!isRecord(message)) continue;
    const result = message as RecordValue;
    if (result.role !== "toolResult" || result.toolName !== "ask" || typeof result.toolCallId !== "string") continue;
    nativeResultIds.add(result.toolCallId);
    if (result.isError === true) continue;

    const call = calls.get(result.toolCallId);
    const details = successfulDetails(result.details);
    if (!call || !details) continue;
    rewritePair(call, result, details);
  }

  const replayCandidates = new Map<string, Array<{ message: T; answer: unknown; details: SuccessfulDetails; timestamp: number }>>();
  for (const message of copied) {
    const replay = replayDetails(message);
    if (!replay || nativeResultIds.has(replay.toolCallId)) continue;
    const call = replayCalls.get(replay.toolCallId);
    if (!call || !matchesCall(replay, call.args)) continue;
    const details = successfulDetails(replay.answer);
    if (!details || !answerMatchesCall(details, call.args)) continue;
    const candidates = replayCandidates.get(replay.toolCallId) ?? [];
    candidates.push({
      message,
      answer: replay.answer,
      details,
      timestamp: isRecord(message) && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    });
    replayCandidates.set(replay.toolCallId, candidates);
  }

  const removals = new Set<T>();
  const insertions = new Map<T, T>();
  for (const [toolCallId, candidates] of replayCandidates) {
    if (candidates.length !== 1) continue;
    const call = replayCalls.get(toolCallId)!;
    const candidate = candidates[0]!;
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId,
      toolName: "ask",
      content: [{ type: "text", text: summarize(candidate.details) }],
      details: candidate.answer,
      isError: false,
      timestamp: candidate.timestamp,
    };
    rewritePair(call, result as unknown as RecordValue, candidate.details);
    removals.add(candidate.message);
    insertions.set(call.message, result as T);
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

type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError: false;
  timestamp: number;
};

type Selection = { label: string; description?: string; comment?: string };
type SuccessfulDetails = { selections: Selection[]; freeform?: string };
type ReplayDetails = {
  version: 1;
  toolCallId: string;
  question: string;
  context?: string;
  allowMultiple: boolean;
  answer: unknown;
};

function replayDetails(value: unknown): ReplayDetails | undefined {
  if (!isRecord(value) || value.customType !== "ask:reanswer" || !isRecord(value.details)) return undefined;
  const details = value.details;
  if (details.version !== 1
    || typeof details.toolCallId !== "string"
    || typeof details.question !== "string"
    || typeof details.allowMultiple !== "boolean"
    || (details.context !== undefined && typeof details.context !== "string")
    || !("answer" in details)) return undefined;
  return details as ReplayDetails;
}

function matchesCall(replay: ReplayDetails, args: RecordValue): boolean {
  return replay.question === args.question
    && replay.context === args.context
    && replay.allowMultiple === (args.allowMultiple === true);
}

function answerMatchesCall(details: SuccessfulDetails, args: RecordValue): boolean {
  if (details.selections.length > 1 && args.allowMultiple !== true) return false;
  if (details.freeform !== undefined && args.allowFreeform !== true) return false;

  const labels = new Set(
    Array.isArray(args.options)
      ? args.options.filter(isRecord).map(option => option.label).filter((label): label is string => typeof label === "string")
      : [],
  );
  const selected = new Set<string>();
  for (const selection of details.selections) {
    if (!labels.has(selection.label) || selected.has(selection.label)) return false;
    selected.add(selection.label);
  }
  return true;
}

function rewritePair(
  call: { block: RecordValue; args: RecordValue },
  result: RecordValue,
  details: SuccessfulDetails,
): void {
  const options = details.selections.map(selection => selectedOption(selection, call.args));
  const arguments_: RecordValue = { question: call.args.question };
  if (typeof call.args.context === "string") arguments_.context = call.args.context;
  if (options.length > 0) arguments_.options = options;
  if (details.selections.length > 1 && call.args.allowMultiple === true) arguments_.allowMultiple = true;
  if (details.freeform !== undefined) arguments_.freeform = details.freeform;
  call.block.arguments = arguments_;
  result.content = [{ type: "text", text: summarize(details) }];
}

function successfulDetails(value: unknown): SuccessfulDetails | undefined {
  if (!isRecord(value) || value.cancelled !== false) return undefined;
  const rawSelections = value.selections ?? value.selectedOptions;
  if (!Array.isArray(rawSelections)) return undefined;

  const selections: Selection[] = [];
  for (const raw of rawSelections) {
    if (!isRecord(raw) || typeof raw.label !== "string") return undefined;
    if (raw.description !== undefined && typeof raw.description !== "string") return undefined;
    if (raw.comment !== undefined && typeof raw.comment !== "string") return undefined;
    selections.push({
      label: raw.label,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.comment === "string" ? { comment: raw.comment } : {}),
    });
  }

  const rawFreeform = value.freeform ?? value.freeformAnswer;
  if (rawFreeform !== undefined && typeof rawFreeform !== "string") return undefined;
  return { selections, ...(rawFreeform !== undefined ? { freeform: rawFreeform } : {}) };
}

function selectedOption(selection: Selection, args: RecordValue): Selection {
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

function summarize(details: SuccessfulDetails): string {
  const selected = details.selections.map(({ label, comment }) => comment ? `${label} (${comment})` : label);
  const parts: string[] = [];
  if (selected.length > 0) parts.push(`Selected: ${selected.join(", ")}`);
  if (details.freeform !== undefined) parts.push(`response: ${details.freeform}`);
  return parts.length > 0 ? parts.join("; ") : "No answer provided.";
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
