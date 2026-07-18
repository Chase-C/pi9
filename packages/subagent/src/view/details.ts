import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import type { ResultEntry } from "../domain/agent-result.js";

export type AgentListingEntry = Omit<AgentConfig, "systemPrompt">;
export type RemoveSummary = { removed: number; aborted: number; conversationIds: string[]; errors?: Array<{ conversationId: string; error: string }> };
export type InventoryFilter = { status?: string[] };
export type RunStartHandle = { runId: string; conversationId: string; agent: string; label?: string };
export type RunStartError = { agent: string; label?: string; error: string };
export type SubagentDetails =
  | { view: "agents"; agents: AgentListingEntry[] }
  | { view: "run"; conversations: AgentSnapshot[]; runStartedAt?: number }
  | { view: "join"; entries: ResultEntry[] }
  | { view: "inventory"; conversations: AgentSnapshot[]; filter?: InventoryFilter }
  | { view: "remove-summary"; summary: RemoveSummary }
  | { view: "runs-started"; handles: RunStartHandle[]; count: number; errors?: RunStartError[] }
  | { view: "error"; errors?: string[] };
export type AgentsDetails = Extract<SubagentDetails, { view: "agents" }>;
export type RunDetails = Extract<SubagentDetails, { view: "run" }>;
export type JoinDetails = Extract<SubagentDetails, { view: "join" }>;
export type InventoryDetails = Extract<SubagentDetails, { view: "inventory" }>;
export type RemoveSummaryDetails = Extract<SubagentDetails, { view: "remove-summary" }>;
export type RunsStartedDetails = Extract<SubagentDetails, { view: "runs-started" }>;
export function agentsDetails(agents: AgentListingEntry[]): AgentsDetails { return { view: "agents", agents }; }
export function runDetails(conversations: AgentSnapshot[], extras: { runStartedAt?: number } = {}): RunDetails { return { view: "run", conversations, ...extras }; }
export function joinDetails(entries: ResultEntry[]): JoinDetails { return { view: "join", entries }; }
export function inventoryDetails(conversations: AgentSnapshot[], filter?: InventoryFilter): InventoryDetails { return { view: "inventory", conversations, ...(filter ? { filter } : {}) }; }
export function runsStartedDetails(conversations: AgentSnapshot[]): RunsStartedDetails {
  const handles = conversations.flatMap(c => c.currentRun ? [{ runId: c.currentRun.runId, conversationId: c.conversationId, agent: c.config.name, ...(c.label ? { label: c.label } : {}) }] : []);
  return { view: "runs-started", handles, count: handles.length };
}
