import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";

import type { AgentSource } from "./agent-config.js";
import type { AgentRunStatus } from "./agent-lifecycle.js";

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
      /** Full, untruncated assistant output for a completed run. Presentation compacts it. */
      readonly output?: string;
      /** Full, untruncated failure text for a non-completed run. */
      readonly error?: string;
      /** Whether the settled attempt was a resume rather than a fresh spawn. */
      readonly resumed?: boolean;
    };

export interface AgentActivitySnapshot {
  readonly messageSnippet?: string;
  readonly turns: number;
  readonly compactions: number;
  readonly toolHistory: readonly AgentToolUse[];
}

/**
 * One completed attempt of a resumed agent, captured per-attempt so previous-run rendering keeps
 * its own prompt, terminal status/output, isolated tool history, and timing/usage — distinct from
 * the current run's activity.
 */
export interface AgentRunSection {
  readonly prompt?: string;
  readonly status: AgentViewStatus;
  readonly activity: AgentActivitySnapshot;
  readonly usage: Usage | undefined;
}

export type AgentDispatch = "foreground" | "background";

export type AgentRetention = "transient" | "persistent";

export interface AgentEffectiveConfig {
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly cwd: string;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly resumable: boolean;
}

export interface AgentViewCapabilities {
  readonly canResume: boolean;
  /** Safe advertised removal capability; explicit remove calls may still abort active sessions. */
  readonly canRemove: boolean;
  /** @deprecated Use canRemove. Retained as a details-payload compatibility alias. */
  readonly canClear: boolean;
}

export interface AgentSnapshot {
  readonly id: string;
  readonly inputIndex?: number;
  readonly parentSessionId?: string;
  readonly label?: string;
  /** Whether the current (or most recent terminal) attempt was a resume. */
  readonly resumed?: boolean;
  readonly prompt?: string;
  readonly createdAt: number;
  readonly config: AgentViewConfig;
  readonly status: AgentViewStatus;
  readonly activity: AgentActivitySnapshot;
  /** Completed prior attempts of a resumed agent, chronological. Absent for a single-run agent. */
  readonly previousRuns?: readonly AgentRunSection[];
  readonly usage: Usage | undefined;
  readonly dispatch: AgentDispatch;
  readonly retention: AgentRetention;
  readonly effectiveConfig?: AgentEffectiveConfig;
  readonly capabilities: AgentViewCapabilities;
}

export interface AgentGroupView {
  statusCounts: Record<string, number>;
  sessions: AgentSnapshot[];
  isError: boolean;
}
