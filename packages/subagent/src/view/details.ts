import { Type } from "typebox";
import { Value } from "typebox/value";

import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import type { ResultEntry } from "../domain/agent-result.js";

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
  label?: string;
};

export type SubagentDetails =
  | { view: "agents"; agents: AgentListingEntry[] }
  | { view: "run"; sessions: AgentSnapshot[]; subtree?: AgentSnapshot[] }
  | { view: "results"; results: ResultEntry[] }
  | { view: "inventory"; sessions: AgentSnapshot[]; filter?: InventoryFilter }
  | { view: "remove-summary"; summary: RemoveSummary }
  | { view: "background-started"; handles: BackgroundSpawnHandle[]; count: number }
  | { view: "error"; errors?: string[] };

/**
 * The renderable arms — everything except the `error` envelope, which the renderer
 * intentionally falls back to plain text for. {@link parseDetails} only ever yields these.
 */
export type RenderableDetails = Exclude<SubagentDetails, { view: "error" }>;

export type AgentsDetails = Extract<SubagentDetails, { view: "agents" }>;
export type RunDetails = Extract<SubagentDetails, { view: "run" }>;
export type ResultsDetails = Extract<SubagentDetails, { view: "results" }>;
export type InventoryDetails = Extract<SubagentDetails, { view: "inventory" }>;
export type RemoveSummaryDetails = Extract<SubagentDetails, { view: "remove-summary" }>;
export type BackgroundStartedDetails = Extract<SubagentDetails, { view: "background-started" }>;

export function agentsDetails(agents: AgentListingEntry[]): AgentsDetails {
  return { view: "agents", agents };
}

export function runDetails(sessions: AgentSnapshot[], extras: { subtree?: AgentSnapshot[] } = {}): RunDetails {
  return { view: "run", sessions, ...extras };
}

export function resultsDetails(results: ResultEntry[]): ResultsDetails {
  return { view: "results", results };
}

export function inventoryDetails(sessions: AgentSnapshot[], filter?: InventoryFilter): InventoryDetails {
  return { view: "inventory", sessions, ...(filter ? { filter } : {}) };
}

export function backgroundStartedDetails(sessions: AgentSnapshot[]): BackgroundStartedDetails {
  const handles: BackgroundSpawnHandle[] = sessions.flatMap(session => {
    if (session.retention !== "persistent") return [];
    return [{
      sessionId: session.id,
      ...(session.label !== undefined ? { label: session.label } : {}),
    }];
  });
  return { view: "background-started", handles, count: handles.length };
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
  Type.Object({ view: Type.Literal("run"), sessions: Type.Array(Type.Unknown()) }),
  Type.Object({ view: Type.Literal("results"), results: Type.Array(Type.Unknown()) }),
  Type.Object({ view: Type.Literal("inventory"), sessions: Type.Array(Type.Unknown()) }),
  Type.Object({
    view: Type.Literal("remove-summary"),
    summary: Type.Object({
      removed: Type.Number(),
      aborted: Type.Number(),
      sessionIds: Type.Array(Type.String()),
      errors: Type.Optional(Type.Array(Type.Object({ sessionId: Type.String(), error: Type.String() }))),
    }),
  }),
  Type.Object({ view: Type.Literal("background-started"), handles: Type.Array(Type.Unknown()), count: Type.Number() }),
]);

/**
 * Validates an opaque `details` payload at the render boundary and returns it typed as a
 * {@link RenderableDetails}, or `undefined` when the shape is unrecognized (including the
 * `error` envelope). The check is deliberately shallow — see {@link DetailsSchema}.
 */
export function parseDetails(details: unknown): RenderableDetails | undefined {
  return Value.Check(DetailsSchema, details) ? (details as RenderableDetails) : undefined;
}
