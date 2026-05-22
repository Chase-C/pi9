import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentGroupView, AgentRunStatus, AgentView } from "../domain/agent-view.js";
import type { BackgroundResult } from "../runtime/agent-manager.js";

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

export type RunOutcome = {
  inputIndex: number;
  agent: string;
  status: AgentRunStatus;
  label?: string;
  sessionId?: string;
  output?: string;
  error?: string;
  resumed?: boolean;
};

export type SubagentDetails =
  | { view: "agents"; agents: AgentListingEntry[] }
  | { view: "run"; group: AgentGroupView; active?: boolean; subtree?: AgentView[] }
  | { view: "run-results"; outcomes: RunOutcome[]; isError: boolean }
  | { view: "inventory"; sessions: AgentView[]; filter?: InventoryFilter }
  | { view: "remove-summary"; summary: RemoveSummary }
  | { view: "background-started"; handles: BackgroundSpawnHandle[]; count: number; background: true }
  | { view: "background-results"; results: BackgroundResult[] };

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
  extras: { active?: boolean; subtree?: AgentView[] } = {},
): RunDetails {
  return { view: "run", group, ...extras };
}

export function runResultsDetails(outcomes: RunOutcome[], isError: boolean): RunResultsDetails {
  return { view: "run-results", outcomes, isError };
}

export function inventoryDetails(sessions: AgentView[], filter?: InventoryFilter): InventoryDetails {
  return { view: "inventory", sessions, ...(filter ? { filter } : {}) };
}

export function backgroundStartedDetails(sessions: AgentView[]): BackgroundStartedDetails {
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

export function narrowDetails(details: unknown): SubagentDetails | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as { view?: unknown; agents?: unknown; group?: unknown; sessions?: unknown; summary?: unknown };
  switch (record.view) {
    case "agents":
      return Array.isArray(record.agents) ? { view: "agents", agents: record.agents as AgentListingEntry[] } : undefined;
    case "run":
      if (!record.group || typeof record.group !== "object") return undefined;
      return {
        view: "run",
        group: record.group as AgentGroupView,
        ...(Array.isArray((record as { subtree?: unknown }).subtree)
          ? { subtree: (record as { subtree: AgentView[] }).subtree }
          : {}),
      };
    case "run-results": {
      const outcomes = (record as { outcomes?: unknown }).outcomes;
      const isError = (record as { isError?: unknown }).isError;
      if (!Array.isArray(outcomes) || typeof isError !== "boolean") return undefined;
      return { view: "run-results", outcomes: outcomes as RunOutcome[], isError };
    }
    case "inventory":
      return Array.isArray(record.sessions)
        ? {
            view: "inventory",
            sessions: record.sessions as AgentView[],
            ...((record as { filter?: InventoryFilter }).filter ? { filter: (record as { filter?: InventoryFilter }).filter } : {}),
          }
        : undefined;
    case "remove-summary":
      return record.summary && typeof record.summary === "object"
        ? { view: "remove-summary", summary: record.summary as RemoveSummary }
        : undefined;
    case "background-started": {
      const handles = (record as { handles?: unknown }).handles;
      const count = (record as { count?: unknown }).count;
      if (!Array.isArray(handles) || typeof count !== "number") return undefined;
      return { view: "background-started", handles: handles as BackgroundSpawnHandle[], count, background: true };
    }
    case "background-results":
      return Array.isArray((record as { results?: unknown }).results)
        ? { view: "background-results", results: (record as { results: BackgroundResult[] }).results }
        : undefined;
    default:
      return undefined;
  }
}
