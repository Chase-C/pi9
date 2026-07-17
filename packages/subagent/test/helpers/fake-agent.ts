import type { Usage } from "@earendil-works/pi-ai";

import type { AgentDispatch, AgentRetentionReason } from "../../src/domain/agent-lifecycle.js";
import type {
  AgentRunSection, AgentSnapshot, AgentToolUse, AgentViewCapabilities, AgentViewStatus,
} from "../../src/domain/agent-snapshot.js";

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const TERMINAL_RESULT_KINDS = ["completed", "error", "interrupted", "aborted", "skipped"] as const;
type TerminalKind = (typeof TERMINAL_RESULT_KINDS)[number];
type FakeStatusInput =
  | { kind: "queued"; queuedAt?: number }
  | { kind: "running"; startedAt?: number }
  | { kind: TerminalKind; startedAt?: number; completedAt?: number; errorAt?: number; interruptedAt?: number; abortedAt?: number; skippedAt?: number; response?: string; error?: string }
  | AgentViewStatus;

export interface FakeAgentOptions {
  id?: string; inputIndex?: number; parentSessionId?: string; label?: string; prompt?: string; createdAt?: number;
  dispatch?: AgentDispatch; kind?: "spawn" | "resume";
  retention?: "transient" | "persistent"; retentionReasons?: AgentRetentionReason[];
  conversation?: Partial<AgentSnapshot["conversation"]>;
  config?: Partial<AgentSnapshot["config"]> & { retainConversation?: boolean };
  options?: { agent?: string; prompt?: string; model?: string; thinking?: AgentSnapshot["config"]["thinking"] };
  status?: FakeStatusInput; activity?: { toolHistory?: AgentToolUse[] }; message?: string; messageSnippet?: string;
  turns?: number; compactions?: number; toolUses?: number; activeTools?: string[]; usage?: Usage; totalUsage?: Usage;
  capabilities?: Partial<AgentViewCapabilities>; previousRuns?: AgentRunSection[]; subagents?: AgentSnapshot[];
}

export function fakeAgent(options: FakeAgentOptions = {}): AgentSnapshot {
  const { config: overrides, options: invocationOverrides, status: statusOverride, activity, ...rest } = options;
  const cfg = { name: "helper", description: "", source: "project" as const, ...overrides };
  const invocation = { agent: cfg.name, prompt: "Fix issue", ...invocationOverrides };
  const base = statusOverride ?? { kind: "completed" as const, startedAt: 1, completedAt: 2, response: "done" };
  let status: AgentViewStatus;
  if ((TERMINAL_RESULT_KINDS as readonly string[]).includes(base.kind)) {
    const terminal = base as Extract<FakeStatusInput, { kind: TerminalKind }>;
    const completedAt = terminal.completedAt ?? terminal.errorAt ?? terminal.skippedAt ?? terminal.interruptedAt ?? terminal.abortedAt ?? 2;
    status = { kind: "done", outcome: terminal.kind, completedAt,
      ...(terminal.startedAt !== undefined ? { startedAt: terminal.startedAt } : {}),
      ...(terminal.kind === "completed" ? { output: terminal.response ?? "done" } : { error: terminal.error ?? `Agent ${terminal.kind}.` }) };
  } else if (base.kind === "running") status = { kind: "running", startedAt: base.startedAt ?? 1 };
  else if (base.kind === "queued") status = { kind: "queued", ...(base.queuedAt !== undefined ? { queuedAt: base.queuedAt } : {}) };
  else status = base as AgentViewStatus;
  let toolHistory: AgentToolUse[];
  if (activity?.toolHistory) toolHistory = [...activity.toolHistory];
  else if (rest.activeTools?.length) toolHistory = rest.activeTools.map((name, i) => ({ id: `${name}-${i}`, name, startedAt: 1 }));
  else toolHistory = Array.from({ length: rest.toolUses ?? 0 }, (_, i) => ({ id: `tool-${i}`, name: `tool-${i}`, startedAt: 1, completedAt: 2 }));
  const dispatch = rest.dispatch ?? "foreground";
  const catalog = rest.retention
    ?? (overrides?.retainConversation || (status.kind === "done" && dispatch === "background") ? "persistent" : "transient");
  const reasons = rest.retentionReasons ?? [
    ...(status.kind !== "done" ? ["active" as const] : []),
    ...(status.kind === "done" && dispatch === "background" ? ["background-result" as const] : []),
    ...(overrides?.retainConversation || (catalog === "persistent" && dispatch === "foreground") ? ["conversation-policy" as const] : []),
  ];
  const policy = rest.conversation?.policy ?? (reasons.includes("conversation-policy") ? "retain" : "release");
  return {
    id: rest.id ?? "s1", ...(rest.inputIndex !== undefined ? { inputIndex: rest.inputIndex } : {}),
    ...(rest.parentSessionId !== undefined ? { parentSessionId: rest.parentSessionId } : {}), ...(rest.label !== undefined ? { label: rest.label } : {}),
    ...(rest.prompt !== undefined ? { prompt: rest.prompt } : {}), createdAt: rest.createdAt ?? 1,
    attempt: { kind: rest.kind ?? "spawn", dispatch },
    conversation: { policy, available: rest.conversation?.available ?? catalog === "persistent" },
    retention: { catalog, reasons },
    config: { name: cfg.name, description: cfg.description, source: cfg.source, sourcePath: cfg.sourcePath,
      model: invocation.model ?? cfg.model, thinking: invocation.thinking ?? cfg.thinking, tools: cfg.tools,
      ...(cfg.skills !== undefined ? { skills: cfg.skills } : {}) },
    status, activity: { ...(rest.messageSnippet ?? rest.message ? { messageSnippet: rest.messageSnippet ?? rest.message } : {}), turns: rest.turns ?? 0, compactions: rest.compactions ?? 0, toolHistory },
    ...(rest.previousRuns ? { previousRuns: rest.previousRuns } : {}), ...(rest.subagents ? { subagents: rest.subagents } : {}),
    usage: rest.totalUsage ?? rest.usage ?? ZERO_USAGE,
    capabilities: { canResume: rest.capabilities?.canResume ?? false, canRemove: rest.capabilities?.canRemove ?? false },
  };
}

export function fakeRunSection(options: FakeAgentOptions = {}): AgentRunSection {
  const snapshot = fakeAgent(options);
  return { ...(snapshot.prompt !== undefined ? { prompt: snapshot.prompt } : {}), attempt: snapshot.attempt, status: snapshot.status, activity: snapshot.activity, usage: snapshot.usage };
}
export const unique = () => `${Date.now()}-${Math.random()}`;
