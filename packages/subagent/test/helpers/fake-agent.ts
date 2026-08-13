import type { Usage } from "@earendil-works/pi-ai";
import type {
  CollectionReceipts,
  ConversationSnapshot,
  GenerationActivitySnapshot,
  GenerationInitiator,
  GenerationKind,
  GenerationOutcomeStatus,
  GenerationSnapshot,
  GenerationToolUse,
  GenerationViewStatus,
} from "../../src/conversation.js";

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export const TERMINAL_GENERATION_OUTCOMES = [
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
      kind: GenerationOutcomeStatus;
      startedAt?: number;
      completedAt?: number;
      response?: string;
      output?: string;
      error?: string;
    }
  | Extract<GenerationViewStatus, { kind: "done" }>;

export interface FakeGenerationOptions {
  generation?: number;
  startedInParentGeneration?: number;
  prompt?: string;
  createdAt?: number;
  kind?: GenerationKind;
  initiatedBy?: GenerationInitiator;
  status?: StatusInput;
  activity?: { phase?: GenerationActivitySnapshot["phase"]; toolHistory?: GenerationToolUse[] };
  message?: string;
  messageSnippet?: string;
  turns?: number;
  compactions?: number;
  activeTools?: string[];
  usage?: Usage;
  totalUsage?: Usage;
  receipts?: Partial<CollectionReceipts>;
  activeCollectionCount?: number;
  nestedJoins?: GenerationSnapshot["nestedJoins"];
  steers?: GenerationSnapshot["steers"];
}

export interface FakeAgentOptions extends FakeGenerationOptions {
  conversationId?: string;
  parentConversationId?: string;
  spawnedInGeneration?: number;
  label?: string;
  config?: Partial<ConversationSnapshot["agent"] & ConversationSnapshot["requestedConfig"]>;
  options?: {
    agent?: string;
    prompt?: string;
    model?: string;
    thinking?: ConversationSnapshot["requestedConfig"]["thinking"];
  };
  resumeAllowed?: boolean;
  isStopping?: boolean;
  requestedOverrides?: ConversationSnapshot["requestedOverrides"];
  previousGenerations?: GenerationSnapshot[];
  generations?: GenerationSnapshot[];
}

function makeStatus(input: StatusInput | undefined): GenerationViewStatus {
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
      ? { output: status.output ?? status.response ?? "done" }
      : { error: status.error ?? `Agent ${status.kind}.` }),
  };
}

export function fakeGeneration(options: FakeGenerationOptions = {}): GenerationSnapshot {
  const status = makeStatus(options.status);
  const tools = options.activity?.toolHistory
    ?? options.activeTools?.map((name, index) => ({
      id: `${name}-${index}`,
      name,
      startedAt: 1,
    }))
    ?? [];
  const generation = options.generation ?? 1;
  return {
    generation,
    kind: options.kind ?? (generation === 1 ? "spawn" : "resume"),
    initiatedBy: options.initiatedBy ?? "model",
    ...(options.startedInParentGeneration !== undefined ? { startedInParentGeneration: options.startedInParentGeneration } : {}),
    prompt: options.prompt ?? "Fix issue",
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
    activeCollectionCount: options.activeCollectionCount ?? 0,
    receipts: { user: options.receipts?.user ?? false, model: options.receipts?.model ?? false },
    nestedJoins: options.nestedJoins ?? [],
    steers: options.steers ?? [],
  };
}

export function fakeAgent(options: FakeAgentOptions = {}): ConversationSnapshot {
  const config = options.config ?? {};
  const previousGenerations = options.previousGenerations ?? [];
  const generationNumber = options.generation ?? previousGenerations.length + 1;
  const generated = fakeGeneration({
    ...options,
    generation: generationNumber,
    ...(options.startedInParentGeneration !== undefined
      ? { startedInParentGeneration: options.startedInParentGeneration }
      : generationNumber === 1 && options.spawnedInGeneration !== undefined
        ? { startedInParentGeneration: options.spawnedInGeneration }
        : {}),
    prompt: options.prompt ?? options.options?.prompt,
    receipts: options.receipts,
  });
  const generations = options.generations ?? [...previousGenerations, generated];
  const latest = generations.at(-1)!;
  const isActive = latest.status.kind === "queued" || latest.status.kind === "running";
  if (isActive && options.resumeAllowed) throw new Error("An active fake conversation cannot allow resume.");
  return {
    conversationId: (options.conversationId ?? "c1") as ConversationSnapshot["conversationId"],
    ...(options.parentConversationId
      ? { parentConversationId: options.parentConversationId as ConversationSnapshot["conversationId"] }
      : {}),
    ...(options.spawnedInGeneration !== undefined ? { spawnedInGeneration: options.spawnedInGeneration } : {}),
    label: options.label ?? options.options?.agent ?? config.name ?? "helper",
    createdAt: options.createdAt ?? 1,
    agent: {
      name: options.options?.agent ?? config.name ?? "helper",
      description: config.description ?? "",
      source: config.source ?? "project",
      ...(config.sourcePath ? { sourcePath: config.sourcePath } : {}),
    },
    requestedConfig: {
      model: options.options?.model ?? config.model,
      thinking: options.options?.thinking ?? config.thinking,
      tools: config.tools,
      skills: config.skills,
    },
    generations,
    resumeAllowed: options.resumeAllowed ?? false,
    ...(isActive ? { currentGeneration: latest } : {}),
    ...(options.isStopping ? { isStopping: true as const } : {}),
    ...(options.requestedOverrides ? { requestedOverrides: options.requestedOverrides } : {}),
  };
}

export const unique = () => `${Date.now()}-${Math.random()}`;
