import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";

import type { AgentSource } from "./agent-config.js";
import type {
  AgentDispatch,
  AgentRetentionReason,
  AgentRunStatus,
  AttemptKind,
  ConversationRetentionPolicy,
} from "./agent-lifecycle.js";

export interface AgentToolUse {
  readonly id: string;
  readonly name: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly isError?: boolean;
  readonly inputSummary?: string;
}
export interface AgentViewConfig {
  readonly name: string;
  readonly description?: string;
  readonly source: AgentSource | undefined;
  readonly sourcePath?: string;
  readonly model: string | undefined;
  readonly thinking: ModelThinkingLevel | undefined;
  readonly tools: readonly string[] | undefined;
  readonly skills?: readonly string[];
}
export type AgentViewStatus =
  | { readonly kind: "queued"; readonly queuedAt?: number }
  | { readonly kind: "running"; readonly startedAt: number }
  | {
      readonly kind: "done";
      readonly outcome: AgentRunStatus;
      readonly completedAt: number;
      readonly startedAt?: number;
      readonly output?: string;
      readonly error?: string;
    };
export interface AgentActivitySnapshot {
  readonly messageSnippet?: string;
  readonly turns: number;
  readonly compactions: number;
  readonly toolHistory: readonly AgentToolUse[];
}
export interface AgentAttemptSnapshot {
  readonly kind: AttemptKind;
  readonly dispatch: AgentDispatch;
}
export interface AgentRunSection {
  readonly prompt?: string;
  readonly attempt: AgentAttemptSnapshot;
  readonly status: AgentViewStatus;
  readonly activity: AgentActivitySnapshot;
  readonly usage: Usage | undefined;
}
export type AgentRetention = "transient" | "persistent";
export interface AgentEffectiveConfig {
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly cwd: string;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
}
export interface AgentViewCapabilities {
  readonly canResume: boolean;
  readonly canRemove: boolean;
}
export interface AgentSnapshot {
  readonly id: string;
  readonly inputIndex?: number;
  readonly parentSessionId?: string;
  readonly label?: string;
  readonly prompt?: string;
  readonly createdAt: number;
  readonly config: AgentViewConfig;
  readonly attempt: AgentAttemptSnapshot;
  readonly conversation: {
    readonly policy: ConversationRetentionPolicy;
    readonly available: boolean;
  };
  readonly retention: {
    readonly catalog: AgentRetention;
    readonly reasons: readonly AgentRetentionReason[];
  };
  readonly status: AgentViewStatus;
  readonly activity: AgentActivitySnapshot;
  readonly previousRuns?: readonly AgentRunSection[];
  readonly subagents?: readonly AgentSnapshot[];
  readonly usage: Usage | undefined;
  readonly effectiveConfig?: AgentEffectiveConfig;
  readonly capabilities: AgentViewCapabilities;
}
export interface AgentGroupView {
  statusCounts: Record<string, number>;
  sessions: AgentSnapshot[];
  isError: boolean;
}
