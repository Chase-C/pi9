import type { Usage } from "@earendil-works/pi-ai";
import type { AgentRunSnapshot, AgentSnapshot, AgentToolUse, AgentViewCapabilities, AgentViewStatus } from "../../src/domain/agent-snapshot.js";
import type { AgentRunStatus, RunKind } from "../../src/domain/agent-lifecycle.js";

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const TERMINAL_RESULT_KINDS = ["completed", "error", "interrupted", "aborted", "skipped"] as const;
type StatusInput = { kind: "queued"; queuedAt?: number } | { kind: "running"; startedAt?: number } | { kind: AgentRunStatus; startedAt?: number; completedAt?: number; response?: string; error?: string } | Extract<AgentViewStatus, { kind: "done" }>;
export interface FakeAgentOptions {
  conversationId?: string; runId?: string; parentConversationId?: string; label?: string; prompt?: string; createdAt?: number; kind?: RunKind;
  config?: Partial<AgentSnapshot["config"]> & { retainConversation?: boolean }; options?: { agent?: string; prompt?: string; model?: string; thinking?: AgentSnapshot["config"]["thinking"] };
  status?: StatusInput; activity?: { toolHistory?: AgentToolUse[] }; message?: string; messageSnippet?: string; turns?: number; compactions?: number; toolUses?: number; activeTools?: string[]; usage?: Usage; totalUsage?: Usage;
  capabilities?: Partial<AgentViewCapabilities>; previousRuns?: AgentRunSnapshot[]; runs?: AgentRunSnapshot[]; subagents?: AgentSnapshot[]; [key: string]: unknown;
}
function makeStatus(input: StatusInput | undefined): AgentViewStatus {
  const status = input ?? { kind: "completed", startedAt: 1, completedAt: 2, response: "done" };
  if (status.kind === "queued") return { kind: "queued", queuedAt: status.queuedAt ?? 1 };
  if (status.kind === "running") return { kind: "running", startedAt: status.startedAt ?? 1 };
  if (status.kind === "done") return status;
  return { kind: "done", outcome: status.kind, startedAt: status.startedAt, completedAt: status.completedAt ?? 2, ...(status.kind === "completed" ? { output: status.response ?? "done" } : { error: status.error ?? `Agent ${status.kind}.` }) };
}
export function fakeAgent(options: FakeAgentOptions = {}): AgentSnapshot {
  const status = makeStatus(options.status); const config = options.config ?? {}; const tools = options.activity?.toolHistory ?? options.activeTools?.map((name, i) => ({ id: `${name}-${i}`, name, startedAt: 1 })) ?? [];
  const run: AgentRunSnapshot = { runId: (options.runId ?? "r1") as AgentRunSnapshot["runId"], kind: options.kind ?? "spawn", prompt: options.prompt ?? options.options?.prompt ?? "Fix issue", createdAt: options.createdAt ?? 1, status, activity: { messageSnippet: options.messageSnippet ?? options.message, turns: options.turns ?? 0, compactions: options.compactions ?? 0, toolHistory: tools }, usage: options.totalUsage ?? options.usage ?? ZERO_USAGE, observerCount: 0, acknowledged: false, notification: "none" };
  const runs = options.runs ?? [...(options.previousRuns ?? []), run];
  return { conversationId: (options.conversationId ?? "c1") as AgentSnapshot["conversationId"], ...(options.parentConversationId ? { parentConversationId: options.parentConversationId as AgentSnapshot["conversationId"] } : {}), label: options.label, createdAt: options.createdAt ?? 1, config: { name: options.options?.agent ?? config.name ?? "helper", description: config.description ?? "", source: config.source ?? "project", sourcePath: config.sourcePath, model: options.options?.model ?? config.model, thinking: options.options?.thinking ?? config.thinking, tools: config.tools, skills: config.skills }, runs, currentRun: runs.at(-1), capabilities: { canResume: options.capabilities?.canResume ?? false, canRemove: options.capabilities?.canRemove ?? false } };
}
export function fakeRunSection(options: FakeAgentOptions = {}): AgentRunSnapshot { return fakeAgent(options).runs.at(-1)!; }
export const unique = () => `${Date.now()}-${Math.random()}`;
