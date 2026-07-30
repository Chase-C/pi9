import type { Usage } from "@earendil-works/pi-ai";
import type {
  RunSnapshot,
  ConversationSnapshot,
  RunToolUse,
  RunViewStatus,
} from "../../src/conversation.js";
import type { RunOutcomeStatus, RunKind } from "../../src/conversation.js";

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export const TERMINAL_RESULT_KINDS = [
  "completed",
  "error",
  "interrupted",
  "aborted",
  "skipped",
] as const;

type StatusInput =
  | { kind: "queued"; queuedAt?: number }
  | { kind: "running"; startedAt?: number }
  | {
      kind: RunOutcomeStatus;
      startedAt?: number;
      completedAt?: number;
      response?: string;
      error?: string;
    }
  | Extract<RunViewStatus, { kind: "done" }>;

export interface FakeAgentOptions {
  conversationId?: string;
  runId?: string;
  parentConversationId?: string;
  spawnedByRunId?: string;
  label?: string;
  prompt?: string;
  createdAt?: number;
  kind?: RunKind;
  config?: Partial<ConversationSnapshot["config"]>;
  options?: {
    agent?: string;
    prompt?: string;
    model?: string;
    thinking?: ConversationSnapshot["config"]["thinking"];
  };
  status?: StatusInput;
  activity?: { phase?: RunSnapshot["activity"]["phase"]; toolHistory?: RunToolUse[] };
  message?: string;
  messageSnippet?: string;
  turns?: number;
  compactions?: number;
  activeTools?: string[];
  usage?: Usage;
  totalUsage?: Usage;
  canResume?: boolean;
  isStopping?: boolean;
  requestedOverrides?: ConversationSnapshot["requestedOverrides"];
  previousRuns?: RunSnapshot[];
  runs?: RunSnapshot[];
}

function makeStatus(input: StatusInput | undefined): RunViewStatus {
  const status = input ?? {
    kind: "completed",
    startedAt: 1,
    completedAt: 2,
    response: "done",
  };
  if (status.kind === "queued") return { kind: "queued", queuedAt: status.queuedAt ?? 1 };
  if (status.kind === "running") return { kind: "running", startedAt: status.startedAt ?? 1 };
  if (status.kind === "done") return status;
  return {
    kind: "done",
    outcome: status.kind,
    startedAt: status.startedAt,
    completedAt: status.completedAt ?? 2,
    ...(status.kind === "completed"
      ? { output: status.response ?? "done" }
      : { error: status.error ?? `Agent ${status.kind}.` }),
  };
}

export function fakeAgent(options: FakeAgentOptions = {}): ConversationSnapshot {
  const status = makeStatus(options.status);
  const config = options.config ?? {};
  const tools = options.activity?.toolHistory
    ?? options.activeTools?.map((name, index) => ({
      id: `${name}-${index}`,
      name,
      startedAt: 1,
    }))
    ?? [];
  const isActive = status.kind === "queued" || status.kind === "running";
  if (isActive && options.canResume) throw new Error("An active fake conversation cannot be resumable.");
  const run: RunSnapshot = {
    runId: (options.runId ?? "r1") as RunSnapshot["runId"],
    kind: options.kind ?? "spawn",
    prompt: options.prompt ?? options.options?.prompt ?? "Fix issue",
    createdAt: options.createdAt ?? 1,
    status,
    activity: {
      phase: options.activity?.phase ?? "starting",
      messageSnippet: options.messageSnippet ?? options.message,
      turns: options.turns ?? 0,
      compactions: options.compactions ?? 0,
      toolHistory: tools,
    },
    usage: options.totalUsage ?? options.usage ?? ZERO_USAGE,
    observerCount: 0,
    acknowledged: options.canResume ?? false,
    steers: [],
  };
  const runs = options.runs ?? [...(options.previousRuns ?? []), run];
  const latest = runs.at(-1)!;
  const state = options.isStopping || latest.status.kind !== "done"
    ? "active"
    : !latest.acknowledged
      ? "awaiting_join"
      : options.canResume ? "resumable" : "terminal";
  return {
    conversationId: (options.conversationId ?? "c1") as ConversationSnapshot["conversationId"],
    ...(options.parentConversationId
      ? { parentConversationId: options.parentConversationId as ConversationSnapshot["conversationId"] }
      : {}),
    ...(options.spawnedByRunId
      ? { spawnedByRunId: options.spawnedByRunId as RunSnapshot["runId"] }
      : {}),
    label: options.label,
    createdAt: options.createdAt ?? 1,
    config: {
      name: options.options?.agent ?? config.name ?? "helper",
      description: config.description ?? "",
      source: config.source ?? "project",
      sourcePath: config.sourcePath,
      model: options.options?.model ?? config.model,
      thinking: options.options?.thinking ?? config.thinking,
      tools: config.tools,
      skills: config.skills,
    },
    runs,
    ...(latest.status.kind !== "done" ? { currentRun: latest } : {}),
    ...(options.isStopping ? { isStopping: true as const } : {}),
    ...(options.requestedOverrides ? { requestedOverrides: options.requestedOverrides } : {}),
    state,
    canResume: state === "resumable",
  };
}

export function fakeRunSection(options: FakeAgentOptions = {}): RunSnapshot {
  return fakeAgent(options).runs.at(-1)!;
}

export const unique = () => `${Date.now()}-${Math.random()}`;
