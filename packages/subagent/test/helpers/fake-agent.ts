import type { Usage } from "@earendil-works/pi-ai";

import type {
  AgentDispatch,
  AgentRetention,
  AgentRunSection,
  AgentSnapshot,
  AgentToolUse,
  AgentViewCapabilities,
  AgentViewStatus,
} from "../../src/domain/agent-snapshot.js";

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

type TerminalKind = (typeof TERMINAL_RESULT_KINDS)[number];

type FakeStatusInput =
  | { kind: "queued"; queuedAt?: number }
  | { kind: "running"; startedAt?: number }
  | ({
      kind: TerminalKind;
      startedAt?: number;
      completedAt?: number;
      errorAt?: number;
      interruptedAt?: number;
      abortedAt?: number;
      skippedAt?: number;
      response?: string;
      error?: string;
      resumed?: boolean;
    })
  | AgentViewStatus;

export interface FakeAgentOptions {
  id?: string;
  inputIndex?: number;
  parentSessionId?: string;
  label?: string;
  resumed?: boolean;
  prompt?: string;
  createdAt?: number;
  dispatch?: AgentDispatch;
  retention?: AgentRetention;
  config?: Partial<AgentSnapshot["config"]>;
  options?: { agent?: string; prompt?: string; model?: string; thinking?: AgentSnapshot["config"]["thinking"] };
  status?: FakeStatusInput;
  activity?: { toolHistory?: AgentToolUse[] };
  message?: string;
  messageSnippet?: string;
  turns?: number;
  compactions?: number;
  toolUses?: number;
  activeTools?: string[];
  usage?: Usage;
  totalUsage?: Usage;
  capabilities?: Partial<AgentViewCapabilities>;
  previousRuns?: AgentRunSection[];
}

export function fakeAgent(options: FakeAgentOptions = {}): AgentSnapshot {
  const {
    config: configOverrides,
    options: optionsOverrides,
    status: statusOverride,
    activity: activityOverride,
    ...rest
  } = options;

  const cfg = {
    name: "helper",
    description: "",
    source: "project" as const,
    resumable: false,
    ...configOverrides,
  };
  const invocation = { agent: cfg.name, prompt: "Fix issue", ...optionsOverrides };
  const baseStatus: FakeStatusInput =
    statusOverride ?? { kind: "completed", startedAt: 1, completedAt: 2, response: "done" };

  let viewStatus: AgentViewStatus;

  if ("kind" in baseStatus && (TERMINAL_RESULT_KINDS as readonly string[]).includes(baseStatus.kind)) {
    const terminal = baseStatus as Extract<FakeStatusInput, { kind: TerminalKind }>;
    const outcome = terminal.kind;
    const completedAt =
      terminal.completedAt ??
      terminal.errorAt ??
      terminal.skippedAt ??
      terminal.interruptedAt ??
      terminal.abortedAt ??
      2;
    const startedAt = terminal.startedAt;
    const output = outcome === "completed" ? terminal.response ?? "done" : undefined;
    const error = outcome === "completed" ? undefined : terminal.error ?? `Agent ${outcome}.`;
    viewStatus = {
      kind: "done",
      outcome,
      completedAt,
      resumed: terminal.resumed ?? false,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  } else if (baseStatus.kind === "running") {
    viewStatus = { kind: "running", startedAt: ("startedAt" in baseStatus && baseStatus.startedAt) || 1 };
  } else if (baseStatus.kind === "queued") {
    viewStatus = {
      kind: "queued",
      ...("queuedAt" in baseStatus && baseStatus.queuedAt !== undefined ? { queuedAt: baseStatus.queuedAt } : {}),
    };
  } else {
    viewStatus = baseStatus as AgentViewStatus;
  }

  const resumable = cfg.resumable;
  const capabilities: AgentViewCapabilities = {
    canResume: rest.capabilities?.canResume ?? false,
    canRemove: rest.capabilities?.canRemove ?? false,
    canClear: rest.capabilities?.canClear ?? false,
  };
  const messageSnippet = rest.messageSnippet ?? rest.message;
  const turns = rest.turns ?? 0;
  const compactions = rest.compactions ?? 0;

  let toolHistory: AgentToolUse[];
  if (activityOverride?.toolHistory) {
    toolHistory = activityOverride.toolHistory;
  } else if (rest.activeTools?.length) {
    toolHistory = rest.activeTools.map((name, i) => ({ id: `${name}-${i}`, name, startedAt: 1 }));
  } else if (rest.toolUses) {
    toolHistory = Array.from({ length: rest.toolUses }, (_, i) => ({
      id: `tool-${i}`,
      name: `tool-${i}`,
      startedAt: 1,
      completedAt: 2,
    }));
  } else {
    toolHistory = [];
  }

  return {
    id: rest.id ?? "s1",
    ...(rest.inputIndex !== undefined ? { inputIndex: rest.inputIndex } : {}),
    ...(rest.parentSessionId !== undefined ? { parentSessionId: rest.parentSessionId } : {}),
    ...(rest.label !== undefined ? { label: rest.label } : {}),
    ...(rest.resumed !== undefined ? { resumed: rest.resumed } : {}),
    ...(rest.prompt !== undefined ? { prompt: rest.prompt } : {}),
    createdAt: rest.createdAt ?? 1,
    dispatch: rest.dispatch ?? "foreground",
    retention: rest.retention ?? "transient",
    config: {
      name: cfg.name,
      description: cfg.description,
      source: cfg.source,
      sourcePath: cfg.sourcePath,
      model: invocation.model ?? cfg.model,
      thinking: invocation.thinking ?? cfg.thinking,
      tools: cfg.tools,
      ...(cfg.skills !== undefined ? { skills: cfg.skills } : {}),
      resumable,
    },
    status: viewStatus,
    activity: {
      ...(messageSnippet ? { messageSnippet } : {}),
      turns,
      compactions,
      toolHistory,
    },
    ...(rest.previousRuns !== undefined ? { previousRuns: rest.previousRuns } : {}),
    usage: rest.totalUsage ?? rest.usage ?? ZERO_USAGE,
    capabilities,
  };
}

/**
 * Builds a single previous-run section by projecting a {@link fakeAgent} snapshot down to the
 * prompt/status/activity/usage fields a run section carries, so tests reuse the same status and
 * tool-history construction.
 */
export function fakeRunSection(options: FakeAgentOptions = {}): AgentRunSection {
  const snapshot = fakeAgent(options);
  return {
    ...(snapshot.prompt !== undefined ? { prompt: snapshot.prompt } : {}),
    status: snapshot.status,
    activity: snapshot.activity,
    usage: snapshot.usage,
  };
}

export const unique = () => `${Date.now()}-${Math.random()}`;
