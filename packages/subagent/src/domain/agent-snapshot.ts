import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { AgentSource } from "./agent-config.js";
import type { AgentRunStatus, RunKind, RunNotificationState } from "./agent-lifecycle.js";
import type { ConversationId } from "./conversation-id.js";
import type { RunId } from "./run-id.js";

export interface AgentToolUse { readonly id: string; readonly name: string; readonly startedAt: number; readonly completedAt?: number; readonly isError?: boolean; readonly inputSummary?: string }
export interface AgentActivitySnapshot { readonly messageSnippet?: string; readonly turns: number; readonly compactions: number; readonly toolHistory: readonly AgentToolUse[] }
export interface AgentViewConfig { readonly name: string; readonly description?: string; readonly source: AgentSource | undefined; readonly sourcePath?: string; readonly model: string | undefined; readonly thinking: ModelThinkingLevel | undefined; readonly tools: readonly string[] | undefined; readonly skills?: readonly string[] }
export interface AgentEffectiveConfig { readonly model?: string; readonly thinking?: ModelThinkingLevel; readonly cwd: string; readonly skills: readonly string[]; readonly tools: readonly string[] }
export type AgentViewStatus =
  | { readonly kind: "queued"; readonly queuedAt: number }
  | { readonly kind: "running"; readonly startedAt: number }
  | { readonly kind: "done"; readonly outcome: AgentRunStatus; readonly completedAt: number; readonly startedAt?: number; readonly output?: string; readonly error?: string };

export interface AgentRunSnapshot {
  readonly runId: RunId;
  readonly kind: RunKind;
  readonly prompt: string;
  readonly createdAt: number;
  readonly status: AgentViewStatus;
  readonly activity: AgentActivitySnapshot;
  readonly usage: Usage | undefined;
  readonly observerCount: number;
  readonly acknowledged: boolean;
  readonly notification: RunNotificationState;
}
export interface AgentViewCapabilities { readonly canResume: boolean; readonly canRemove: boolean }
export interface AgentSnapshot {
  readonly conversationId: ConversationId;
  /** Compatibility-free aggregate identity; consumers should use conversationId. */
  readonly parentConversationId?: ConversationId;
  /** Exact immutable run which spawned this conversation. */
  readonly parentRunId?: RunId;
  readonly label?: string;
  readonly createdAt: number;
  readonly config: AgentViewConfig;
  readonly runs: readonly AgentRunSnapshot[];
  readonly currentRun?: AgentRunSnapshot;
  readonly effectiveConfig?: AgentEffectiveConfig;
  readonly capabilities: AgentViewCapabilities;
}
