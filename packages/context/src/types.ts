import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";

export type ContextReport = ConversationContextReport | StaticContextReport;

export interface ConversationContextReport {
  kind: "conversation";
  model: ModelDetails;
  usage: ContextUsage;
  compaction: CompactionDetails;
  promptTokens: number;
  tools: ToolDetails[];
  skills: SkillDetails[];
  memory: MemoryDetails[];
  snapshot: SnapshotDetails;
  conversation: ConversationDetails;
}

export interface StaticContextReport {
  kind: "static";
  model: ModelDetails;
  usage: ContextUsage;
  compaction: CompactionDetails;
  promptTokens: number;
  tools: ToolDetails[];
  skills: SkillDetails[];
}

export interface CompactionDetails {
  enabled: boolean;
  reserveTokens: number;
}

export interface ModelDetails {
  provider: string;
  id: string;
  name: string;
  thinking?: ModelThinkingLevel;
  contextWindow?: number;
}

export interface ToolDetails {
  name: string;
  tokens: number;
  definitionTokens: number;
  promptTokens: number;
  source: ToolSource;
  active: boolean;
}

export type ToolSource =
  | { kind: "builtin" }
  | { kind: "extension"; name: string }
  | { kind: "mcp"; name: string };

export interface SkillDetails {
  name: string;
  descTokens: number;
  bodyTokens: number;
  scope: "user" | "project";
}

export interface MemoryDetails {
  path: string;
  tokens: number;
}

export interface SnapshotDetails {
  capturedAt: number;
}

export interface ConversationDetails {
  stats: ConversationStats;
  history: ConversationTurn[];
  tokens: number;
}

export interface ConversationStats {
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  toolCalls: number;
  thinkingBlocks: number;
  imageBlocks: number;
  compactions: number;
}

export type ConversationTurn =
  | {
      kind: "user" | "assistant" | "thinking" | "bash" | "custom" | "compact" | "branch";
      tokens: number;
    }
  | {
      kind: "tool-call";
      tool: string;
      tokens: number;
      callId?: string;
    }
  | {
      kind: "tool-result";
      tool: string;
      tokens: number;
      callId?: string;
      isError?: boolean;
    };
