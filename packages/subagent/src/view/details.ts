import { Type } from "typebox";
import { Value } from "typebox/value";

import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentGroupView, AgentSnapshot } from "../domain/agent-snapshot.js";
import type { AgentResultJson, BackgroundResult } from "../domain/agent-result.js";

export type AgentListingEntry = Omit<AgentConfig, "systemPrompt">;

export type RemoveSummary = {
  removed: number;
  aborted: number;
  sessionIds: string[];
  errors?: Array<{ sessionId: string; error: string }>;
};

export type InventoryFilter = { status?: string[] };

export type BackgroundSpawnHandle = {
  sessionId: string;
  inputIndex: number;
  label?: string;
};

export type SubagentDetails =
  | { view: "agents"; agents: AgentListingEntry[] }
  | { view: "run"; group: AgentGroupView; active?: boolean; subtree?: AgentSnapshot[] }
  | { view: "run-results"; outcomes: AgentResultJson[]; isError: boolean }
  | { view: "inventory"; sessions: AgentSnapshot[]; filter?: InventoryFilter }
  | { view: "remove-summary"; summary: RemoveSummary }
  | { view: "background-started"; handles: BackgroundSpawnHandle[]; count: number; background: true }
  | { view: "background-results"; results: BackgroundResult[] }
  | { view: "error"; errors?: string[] };

/**
 * The renderable arms — everything except the `error` envelope, which the renderer
 * intentionally falls back to plain text for. {@link parseDetails} only ever yields these.
 */
export type RenderableDetails = Exclude<SubagentDetails, { view: "error" }>;

export type AgentsDetails = Extract<SubagentDetails, { view: "agents" }>;
export type RunDetails = Extract<SubagentDetails, { view: "run" }>;
export type RunResultsDetails = Extract<SubagentDetails, { view: "run-results" }>;
export type InventoryDetails = Extract<SubagentDetails, { view: "inventory" }>;
export type RemoveSummaryDetails = Extract<SubagentDetails, { view: "remove-summary" }>;
export type BackgroundStartedDetails = Extract<SubagentDetails, { view: "background-started" }>;
export type BackgroundResultsDetails = Extract<SubagentDetails, { view: "background-results" }>;

export function agentsDetails(agents: AgentListingEntry[]): AgentsDetails {
  return { view: "agents", agents };
}

export function runDetails(
  group: AgentGroupView,
  extras: { active?: boolean; subtree?: AgentSnapshot[] } = {},
): RunDetails {
  return { view: "run", group, ...extras };
}

export function runResultsDetails(outcomes: AgentResultJson[], isError: boolean): RunResultsDetails {
  return { view: "run-results", outcomes, isError };
}

export function inventoryDetails(sessions: AgentSnapshot[], filter?: InventoryFilter): InventoryDetails {
  return { view: "inventory", sessions, ...(filter ? { filter } : {}) };
}

export function backgroundStartedDetails(sessions: AgentSnapshot[]): BackgroundStartedDetails {
  const handles: BackgroundSpawnHandle[] = sessions.flatMap((session, index) => {
    if (session.retention !== "persistent") return [];
    return [{
      sessionId: session.id,
      inputIndex: session.inputIndex ?? index,
      ...(session.label !== undefined ? { label: session.label } : {}),
    }];
  });
  return { view: "background-started", handles, count: sessions.length, background: true };
}

export function backgroundResultsDetails(results: BackgroundResult[]): BackgroundResultsDetails {
  return { view: "background-results", results };
}

/**
 * Shallow structural schema for the `details` envelope. Each arm pins the `view` tag and the
 * top-level fields the renderer reads; nested rows stay `Unknown` so this stays a tag/shape
 * check, not a re-derivation of the domain types. It exists only to guard the persisted /
 * HTML-exported re-render path (the live path passes the already-typed object), backed by
 * `renderResult`'s try/catch → plain-text fallback for anything it rejects.
 */
const DetailsSchema = Type.Union([
  Type.Object({ view: Type.Literal("agents"), agents: Type.Array(Type.Unknown()) }),
  Type.Object({ view: Type.Literal("run"), group: Type.Object({ sessions: Type.Array(Type.Unknown()) }) }),
  Type.Object({ view: Type.Literal("run-results"), outcomes: Type.Array(Type.Unknown()), isError: Type.Boolean() }),
  Type.Object({ view: Type.Literal("inventory"), sessions: Type.Array(Type.Unknown()) }),
  Type.Object({ view: Type.Literal("remove-summary"), summary: Type.Object({}) }),
  Type.Object({ view: Type.Literal("background-started"), handles: Type.Array(Type.Unknown()), count: Type.Number() }),
  Type.Object({ view: Type.Literal("background-results"), results: Type.Array(Type.Unknown()) }),
]);

/**
 * Validates an opaque `details` payload at the render boundary and returns it typed as a
 * {@link RenderableDetails}, or `undefined` when the shape is unrecognized (including the
 * `error` envelope). The check is deliberately shallow — see {@link DetailsSchema}.
 */
export function parseDetails(details: unknown): RenderableDetails | undefined {
  return Value.Check(DetailsSchema, details) ? (details as RenderableDetails) : undefined;
}
