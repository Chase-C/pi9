import type { Usage } from "@earendil-works/pi-ai";
import type {
  AgentRunSnapshot,
  AgentSnapshot,
  AgentToolUse,
  AgentViewStatus,
} from "../../src/domain/agent-snapshot.js";
import type { AgentRunStatus, RunKind } from "../../src/domain/agent-lifecycle.js";

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
      kind: AgentRunStatus;
      startedAt?: number;
      completedAt?: number;
      response?: string;
      error?: string;
    }
  | Extract<AgentViewStatus, { kind: "done" }>;

export interface FakeAgentOptions {
  conversationId?: string;
  runId?: string;
  parent?: { conversationId: string; runId: string };
  label?: string;
  prompt?: string;
  createdAt?: number;
  kind?: RunKind;
  config?: Partial<AgentSnapshot["config"]>;
  options?: {
    agent?: string;
    prompt?: string;
    model?: string;
    thinking?: AgentSnapshot["config"]["thinking"];
  };
  status?: StatusInput;
  activity?: { toolHistory?: AgentToolUse[] };
  message?: string;
  messageSnippet?: string;
  turns?: number;
  compactions?: number;
  activeTools?: string[];
  usage?: Usage;
  totalUsage?: Usage;
  canResume?: boolean;
  previousRuns?: AgentRunSnapshot[];
  runs?: AgentRunSnapshot[];
}

function makeStatus(input: StatusInput | undefined): AgentViewStatus {
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

export function fakeAgent(options: FakeAgentOptions = {}): AgentSnapshot {
  const status = makeStatus(options.status);
  const config = options.config ?? {};
  const tools = options.activity?.toolHistory
    ?? options.activeTools?.map((name, index) => ({
      id: `${name}-${index}`,
      name,
      startedAt: 1,
    }))
    ?? [];
  const run: AgentRunSnapshot = {
    runId: (options.runId ?? "r1") as AgentRunSnapshot["runId"],
    kind: options.kind ?? "spawn",
    prompt: options.prompt ?? options.options?.prompt ?? "Fix issue",
    createdAt: options.createdAt ?? 1,
    status,
    activity: {
      messageSnippet: options.messageSnippet ?? options.message,
      turns: options.turns ?? 0,
      compactions: options.compactions ?? 0,
      toolHistory: tools,
    },
    usage: options.totalUsage ?? options.usage ?? ZERO_USAGE,
    observerCount: 0,
    acknowledged: false,
  };
  const runs = options.runs ?? [...(options.previousRuns ?? []), run];
  return {
    conversationId: (options.conversationId ?? "c1") as AgentSnapshot["conversationId"],
    ...(options.parent
      ? {
          parent: {
            conversationId: options.parent.conversationId as AgentSnapshot["conversationId"],
            runId: options.parent.runId as AgentRunSnapshot["runId"],
          },
        }
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
    currentRun: runs.at(-1),
    canResume: options.canResume ?? false,
  };
}

export function fakeRunSection(options: FakeAgentOptions = {}): AgentRunSnapshot {
  return fakeAgent(options).runs.at(-1)!;
}

export const unique = () => `${Date.now()}-${Math.random()}`;
