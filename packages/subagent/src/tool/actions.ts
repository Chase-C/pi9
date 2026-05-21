import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentView } from "../domain/agent-view.js";
import type { AgentManager, RunUpdate } from "../runtime/agent-manager.js";
import { timingMark, timingStart, timingSync } from "../runtime/timing.js";
import {
  isSessionStatus,
  parseTask,
  SESSION_STATUSES,
  SubagentParams,
  type SessionStatus,
  type TaskRequest,
} from "../schema.js";
import type { SubagentSettings } from "../ui/settings.js";
import { updateSubagentWidget } from "../ui/widget.js";
import {
  agentsDetails,
  backgroundResultsDetails,
  backgroundStartedDetails,
  formatSubagentToolLines,
  inventoryDetails,
  runDetails,
  runResultsDetails,
  type RunOutcome,
} from "../view/format.js";
import { listAgentDefinitions, serializeGroup } from "../view/serialize.js";

export interface ActionDeps {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  getCurrentSettings: () => SubagentSettings;
  parentSessionId?: string;
}

export interface ActionResult {
  content: { type: "text"; text: string }[];
  details: unknown;
  isError?: boolean;
}

export function toolResult(details: object, isError = false): ActionResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
    isError,
  };
}

export function errorResult(message: string, details: Record<string, unknown> = {}): ActionResult {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
    isError: true,
  };
}

export function agentsAction(deps: ActionDeps): ActionResult {
  return toolResult(agentsDetails(listAgentDefinitions(deps.agentRegistry)));
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
  return toolResult(inventoryDetails(deps.agentManager.listSessions(filter), filter));
}

export async function resultsAction(deps: ActionDeps, params: SubagentParams): Promise<ActionResult> {
  const { sessionIds } = params;
  if (!isStringArray(sessionIds)) return errorResult("results sessionIds must be an array of strings.");
  if (!isNonEmptyStringArray(sessionIds)) return errorResult("results sessionIds must be an array of non-empty strings.");
  if (sessionIds.length === 0) return errorResult("results requires at least one sessionId.");
  const results = await deps.agentManager.backgroundResults(sessionIds, { remove: params.remove === true });
  return toolResult(backgroundResultsDetails(results));
}

export async function removeAction(deps: ActionDeps, params: SubagentParams): Promise<ActionResult> {
  const { sessionIds, scope } = params;
  const hasIds = sessionIds !== undefined;
  const hasScope = scope !== undefined;
  if (hasIds && hasScope) return errorResult("remove requires exactly one of sessionIds or scope.");
  if (!hasIds && !hasScope) return errorResult("remove requires either sessionIds or scope.");
  if (hasIds && !isStringArray(sessionIds)) return errorResult("remove sessionIds must be an array of strings.");
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
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  settings: SubagentSettings,
): Promise<ActionResult> {
  const countError = validateTaskCount(params.tasks, settings.runtime.maxTasksPerRun);
  if (countError) {
    return errorResult(`${countError}\n\nAvailable agents:\n${deps.agentRegistry.summarizeAgent()}`);
  }

  const parsed: TaskRequest[] = [];
  const errors: string[] = [];
  timingSync("tool.parseTasks", { taskCount: params.tasks?.length ?? 0 }, () => {
    params.tasks?.forEach((raw, index) => {
      const result = parseTask(raw);
      if ("error" in result) errors.push(`task[${index}]: ${result.error}`);
      else parsed.push(result);
    });
  });

  if (errors.length > 0) return errorResult(errors.join("\n"), { errors });

  const startOptions = deps.parentSessionId !== undefined
    ? { background: params.background === true, parentSessionId: deps.parentSessionId }
    : { background: params.background === true };

  if (params.background === true) {
    const handle = deps.agentManager.startRun(ctx, signal, parsed, update => {
      updateSubagentWidget(ctx, update.sessions, deps.getCurrentSettings());
    }, startOptions);
    handle.resultsPromise.catch(() => {});
    updateSubagentWidget(ctx, handle.sessions, deps.getCurrentSettings());
    return toolResult(backgroundStartedDetails(handle.sessions));
  }

  const runEnd = timingStart("tool.agentManager.run", { taskCount: parsed.length, isChild: deps.parentSessionId !== undefined });
  const emitPartial = (update: RunUpdate) => {
    const partial = timingSync("tool.update.partialToolResult", { sessionCount: update.sessions.length, treeCount: update.tree.length }, () => partialToolResult(update));
    timingSync("tool.update.onUpdate", { textLength: partial.content[0]?.text.length ?? 0 }, () => { onUpdate?.(partial); });
    timingSync("tool.update.widget", { sessionCount: update.sessions.length }, () => updateSubagentWidget(ctx, update.sessions, deps.getCurrentSettings()));
  };
  const handle = deps.agentManager.startRun(ctx, signal, parsed, update => {
    timingMark("tool.update.received", { sessionCount: update.sessions.length, treeCount: update.tree.length, active: update.active });
    emitPartial(update);
  }, startOptions);
  const results = deps.parentSessionId !== undefined
    ? await deps.agentManager.suspendAgentSlotDuring(deps.parentSessionId, () => handle.resultsPromise)
    : await handle.resultsPromise;
  runEnd({ ok: true, resultCount: results.length });
  timingSync("tool.finalWidget", { sessionCount: deps.agentManager.listSessions().length }, () => updateSubagentWidget(ctx, deps.agentManager.listSessions(), deps.getCurrentSettings()));
  const isError = results.some(result => result.status !== "completed");
  const outcomes: RunOutcome[] = results.map((result, inputIndex) => ({
    inputIndex,
    agent: result.agent,
    status: result.status,
    ...(result.label !== undefined ? { label: result.label } : {}),
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.resumed ? { resumed: true } : {}),
  }));
  return toolResult(runResultsDetails(outcomes, isError), isError);
}

function partialToolResult(update: RunUpdate): { content: { type: "text"; text: string }[]; details: unknown } {
  const subtree: AgentView[] = update.tree.length > update.sessions.length ? update.tree : [];
  const details = runDetails(serializeGroup(update.sessions), {
    active: update.active,
    ...(subtree.length > 0 ? { subtree: update.tree } : {}),
  });
  return {
    content: [{ type: "text" as const, text: formatSubagentToolLines(details, true).join("\n") }],
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
