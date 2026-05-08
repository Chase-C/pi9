import type { ModelThinkingLevel, Usage } from "@mariozechner/pi-ai";

import type { AgentSource } from "./agent-config.js";

export type AgentRunStatus = "completed" | "error" | "aborted" | "skipped" | "interrupted";

export type AgentUpdateKind = "status" | "message" | "tool" | "turn" | "usage" | "compaction";

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
  readonly resumable: boolean;
}

export type AgentViewStatus =
  | { readonly kind: "queued" }
  | { readonly kind: "running"; readonly startedAt: number }
  | {
      readonly kind: "done";
      readonly outcome: AgentRunStatus;
      readonly completedAt: number;
      readonly startedAt?: number;
      readonly snippet?: string;
    };

export interface AgentActivityView {
  readonly messageSnippet?: string;
  readonly turns: number;
  readonly compactions: number;
  readonly toolHistory: readonly AgentToolUse[];
}

export interface AgentView {
  readonly id: string;
  readonly inputIndex?: number;
  readonly createdAt: number;
  readonly config: AgentViewConfig;
  readonly status: AgentViewStatus;
  readonly activity: AgentActivityView;
  readonly usage: Usage | undefined;
}

export interface AgentGroupView {
  statusCounts: Record<string, number>;
  sessions: AgentView[];
  isError: boolean;
}

export interface SubagentBatchUpdate {
  sessions: AgentView[];
  active: boolean;
}
