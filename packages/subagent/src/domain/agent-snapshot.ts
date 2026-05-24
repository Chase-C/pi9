import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";

import type { AgentSource } from "./agent-config.js";
import type { AgentRunStatus } from "./agent-result.js";

export interface AgentToolUse {
  readonly id: string;
  readonly name: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly isError?: boolean;
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
  readonly resumable: boolean;
}

export type AgentViewStatus =
  | { readonly kind: "queued"; readonly queuedAt?: number }
  | { readonly kind: "running"; readonly startedAt: number }
  | {
      readonly kind: "done";
      readonly outcome: AgentRunStatus;
      readonly completedAt: number;
      readonly startedAt?: number;
      readonly snippet?: string;
    };

export interface AgentActivitySnapshot {
  readonly messageSnippet?: string;
  readonly turns: number;
  readonly compactions: number;
  readonly toolHistory: readonly AgentToolUse[];
}

export type AgentDispatch = "foreground" | "background";

export type AgentRetention = "transient" | "persistent";

export interface AgentViewCapabilities {
  readonly canResume: boolean;
  readonly canClear: boolean;
}

export interface AgentSnapshot {
  readonly id: string;
  readonly inputIndex?: number;
  readonly parentSessionId?: string;
  readonly label?: string;
  readonly resumed?: boolean;
  readonly prompt?: string;
  readonly createdAt: number;
  readonly config: AgentViewConfig;
  readonly status: AgentViewStatus;
  readonly activity: AgentActivitySnapshot;
  readonly usage: Usage | undefined;
  readonly dispatch: AgentDispatch;
  readonly retention: AgentRetention;
  readonly capabilities: AgentViewCapabilities;
}

export interface AgentGroupView {
  statusCounts: Record<string, number>;
  sessions: AgentSnapshot[];
  isError: boolean;
}

export interface SubagentBatchUpdate {
  sessions: AgentSnapshot[];
  active: boolean;
}
