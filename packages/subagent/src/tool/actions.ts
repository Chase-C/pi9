import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { toResults, type ResultEntry } from "../domain/agent-result.js";
import type { AgentManager, RunUpdate } from "../runtime/agent-manager.js";
import { timingStart } from "../runtime/timing.js";
import {
  isSessionStatus,
  parseTask,
  SESSION_STATUSES,
  SubagentParams,
  type SessionStatus,
  type TaskRequest,
} from "../schema.js";
import type { SubagentSettings } from "../config/settings.js";
import { updateSubagentWidget } from "../ui/widget.js";
import {
  agentsDetails,
  backgroundStartedDetails,
  formatSubagentToolLines,
  inventoryDetails,
  resultsDetails,
  runDetails,
  type SubagentDetails,
} from "../view/format.js";
import {
  listAgentDefinitions,
  listAgentDefinitionsForModel,
  serializeInventoryForModel,
} from "../view/serialize.js";

export interface ActionDeps {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  getCurrentSettings: () => SubagentSettings;
  parentSessionId?: string;
}

export interface ActionResult {
  content: { type: "text"; text: string }[];
  details: SubagentDetails;
  isError?: boolean;
}

/**
 * Builds a tool result. The model-facing `content` text is `json` when provided, else the
 * serialized `details`. They diverge only for the `results` envelope, whose `details` carries
 * snapshots for rendering while `content` carries the projected model-facing JSON.
 */
export function toolResult(details: SubagentDetails, opts: { isError?: boolean; json?: unknown } = {}): ActionResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(opts.json ?? details, null, 2) }],
    details,
    isError: opts.isError ?? false,
  };
}

export function errorResult(message: string, extra: { errors?: string[] } = {}): ActionResult {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { view: "error", ...(extra.errors ? { errors: extra.errors } : {}) },
    isError: true,
  };
}

export function agentsAction(deps: ActionDeps): ActionResult {
  return toolResult(agentsDetails(listAgentDefinitions(deps.agentRegistry)), {
    json: { view: "agents", agents: listAgentDefinitionsForModel(deps.agentRegistry) },
  });
}

export function listAction(deps: ActionDeps, params: SubagentParams): ActionResult {
  if ((params as { type?: unknown }).type !== undefined) {
    return errorResult(
      "The 'type' parameter has been removed. Use action: 'agents' to list definitions, or action: 'list' (optionally with status: [...]) for sessions. Skills listing is no longer exposed through the subagent tool.",
    );
  }
  const statusFilter = params.status;
  if (statusFilter !== undefined && !Array.isArray(statusFilter)) {
    return errorResult("list status must be an array of status strings.");
  }
  const invalidStatus = statusFilter?.find(value => !isSessionStatus(value));
  if (invalidStatus !== undefined) {
    return errorResult(`Unknown status '${String(invalidStatus)}'. Valid: ${SESSION_STATUSES.join(", ")}.`);
  }
  const filter = statusFilter !== undefined ? { status: statusFilter as SessionStatus[] } : undefined;
  const sessions = deps.agentManager.listSessions(filter);
  return toolResult(inventoryDetails(sessions, filter), {
    json: serializeInventoryForModel(sessions, filter),
  });
}

export async function resultsAction(deps: ActionDeps, params: SubagentParams): Promise<ActionResult> {
  const { sessionIds } = params;
  if (!isStringArray(sessionIds)) return errorResult("results sessionIds must be an array of strings.");
  if (!isNonEmptyStringArray(sessionIds)) return errorResult("results sessionIds must be an array of non-empty strings.");
  if (sessionIds.length === 0) return errorResult("results requires at least one sessionId.");
  const entries = deps.agentManager.backgroundResults(sessionIds);
  if (params.remove) {
    const terminalIds = entries.flatMap(e => "snapshot" in e && e.snapshot.status.kind === "done" ? [e.snapshot.id] : []);
    await deps.agentManager.remove({ sessionIds: terminalIds });
  }
  return toolResult(resultsDetails(entries), { json: resultsJson(entries, { exposeId: true }) });
}

export async function removeAction(deps: ActionDeps, params: SubagentParams): Promise<ActionResult> {
  const { sessionIds, scope } = params;
  const hasIds = sessionIds !== undefined;
  const hasScope = scope !== undefined;
  if (hasIds && hasScope) return errorResult("remove requires exactly one of sessionIds or scope.");
  if (!hasIds && !hasScope) return errorResult("remove requires either sessionIds or scope.");
  if (hasIds && !isStringArray(sessionIds)) return errorResult("remove sessionIds must be an array of strings.");
  if (hasIds && sessionIds.length === 0) return errorResult("remove requires at least one sessionId.");
  if (hasScope && !isRemoveScope(scope)) {
    return errorResult('remove scope must be "background", "retained", or "non-running".');
  }
  const summary = hasIds
    ? await deps.agentManager.remove({ sessionIds })
    : await deps.agentManager.remove({ scope: scope! });
  return toolResult({ view: "remove-summary", summary });
}

export async function runAction(
  deps: ActionDeps,
  params: SubagentParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
  settings: SubagentSettings,
): Promise<ActionResult> {
  const countError = validateTaskCount(params.tasks, settings.runtime.maxTasksPerRun);
  if (countError) {
    return errorResult(`${countError}\n\nAvailable agents:\n${deps.agentRegistry.summarizeAgent()}`);
  }

  const parsed: TaskRequest[] = [];
  const errors: string[] = [];
  params.tasks?.forEach((raw, index) => {
    const result = parseTask(raw);
    if ("error" in result) errors.push(`task[${index}]: ${result.error}`);
    else parsed.push(result);
  });

  if (errors.length > 0) return errorResult(errors.join("\n"), { errors });

  const startOptions = deps.parentSessionId !== undefined
    ? { background: params.background === true, parentId: deps.parentSessionId }
    : { background: params.background === true };

  if (params.background === true) {
    const handle = deps.agentManager.startRun(ctx, signal, parsed, () => {
      updateSubagentWidget(ctx, deps.agentManager.listSessions(), deps.getCurrentSettings());
    }, startOptions);
    handle.resultsPromise.catch(() => {});
    updateSubagentWidget(ctx, deps.agentManager.listSessions(), deps.getCurrentSettings());
    return toolResult(backgroundStartedDetails(handle.sessions));
  }

  const runStartedAt = Date.now();
  const runEnd = timingStart("tool.agentManager.run", { taskCount: parsed.length, isChild: deps.parentSessionId !== undefined });
  const emitPartial = (update: RunUpdate) => {
    const partial = partialToolResult(update, deps.getCurrentSettings().display, runStartedAt);
    onUpdate?.(partial);
    updateSubagentWidget(ctx, deps.agentManager.listSessions(), deps.getCurrentSettings());
  };
  const handle = deps.agentManager.startRun(ctx, signal, parsed, emitPartial, startOptions);
  const settled = deps.parentSessionId !== undefined
    ? await deps.agentManager.runner.suspendAgentSlotDuring(deps.parentSessionId, () => handle.resultsPromise)
    : await handle.resultsPromise;
  runEnd({ ok: true, resultCount: settled.length });
  updateSubagentWidget(ctx, deps.agentManager.listSessions(), deps.getCurrentSettings());
  // The terminal snapshot is the result: each settled run is a ready entry, the same shape a
  // background poll yields, so both feed the one `results` renderer and the one JSON projection.
  const entries: ResultEntry[] = settled.map(snapshot => ({ snapshot }));
  const isError = settled.some(s => s.status.kind === "done" && s.status.outcome !== "completed");
  return toolResult(resultsDetails(entries), { isError, json: resultsJson(entries) });
}

/** The model-facing `results` envelope: the `view` tag plus the projected per-entry JSON. */
function resultsJson(entries: ResultEntry[], opts?: { exposeId?: boolean }) {
  return { view: "results" as const, results: toResults(entries, opts) };
}

function partialToolResult(update: RunUpdate, display: import("../config/settings.js").SubagentDisplaySettings, runStartedAt: number): { content: { type: "text"; text: string }[]; details: SubagentDetails } {
  const subtree: AgentSnapshot[] = update.tree.length > update.sessions.length ? update.tree : [];
  const details = runDetails(update.sessions, { ...(subtree.length > 0 ? { subtree: update.tree } : {}), runStartedAt });
  return {
    content: [{ type: "text" as const, text: formatSubagentToolLines(details, true, Date.now(), display).join("\n") }],
    details,
  };
}

function validateTaskCount(tasks: SubagentParams["tasks"] | undefined, maxTasks: number): string | undefined {
  if (!Array.isArray(tasks)) return "Provide a tasks array for action=run.";
  if (tasks.length === 0) return "Provide at least one task.";
  if (tasks.length > maxTasks) return `Too many tasks (${tasks.length}). Max is ${maxTasks}.`;
  return undefined;
}

function isRemoveScope(scope: unknown): scope is "background" | "retained" | "non-running" {
  return scope === "background" || scope === "retained" || scope === "non-running";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string" && v.trim() !== "");
}
