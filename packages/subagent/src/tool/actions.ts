import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { toResults, type ResultEntry } from "../domain/agent-result.js";
import type { AgentManager, RunUpdate } from "../runtime/agent-manager.js";
import { timingStart } from "../runtime/timing.js";
import {
  type SubagentAction,
  type SubagentInvocation,
  type SubagentInvocationParseError,
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
 * serialized `details`. Inventory and results keep rich snapshots in `details` for rendering
 * while `content` carries their narrower model-facing projections.
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

export function agentsAction(deps: ActionDeps, _invocation: InvocationFor<"agents">): ActionResult {
  return toolResult(agentsDetails(listAgentDefinitions(deps.agentRegistry)), {
    json: { view: "agents", agents: listAgentDefinitionsForModel(deps.agentRegistry) },
  });
}

type InvocationFor<A extends SubagentAction> = Extract<SubagentInvocation, { action: A }>;

export function invocationErrorResult(deps: ActionDeps, parsed: SubagentInvocationParseError): ActionResult {
  const message = parsed.missingAction || parsed.taskCountError
    ? `${parsed.error}\n\nAvailable agents:\n${deps.agentRegistry.summarizeAgent()}`
    : parsed.error;
  return errorResult(message, parsed.errors ? { errors: parsed.errors } : {});
}

export function listAction(deps: ActionDeps, invocation: InvocationFor<"list">): ActionResult {
  const filter = invocation.status !== undefined ? { status: invocation.status } : undefined;
  const sessions = deps.agentManager.listSessions(filter);
  return toolResult(inventoryDetails(sessions, filter), {
    json: serializeInventoryForModel(sessions, filter),
  });
}

export async function resultsAction(deps: ActionDeps, invocation: InvocationFor<"results">, ctx?: ExtensionContext): Promise<ActionResult> {
  const { sessionIds } = invocation;
  const entries = deps.agentManager.backgroundResults(sessionIds);
  if (invocation.remove) {
    const terminalIds = entries.flatMap(e => "snapshot" in e && e.snapshot.status.kind === "done" ? [e.snapshot.id] : []);
    await deps.agentManager.remove({ sessionIds: terminalIds });
    if (ctx) updateSubagentWidget(ctx, deps.agentManager.listSessions(), deps.getCurrentSettings());
  }
  return toolResult(resultsDetails(entries), { json: resultsJson(entries, { exposeId: true }) });
}

export async function removeAction(deps: ActionDeps, invocation: InvocationFor<"remove">, ctx?: ExtensionContext): Promise<ActionResult> {
  const summary = await deps.agentManager.remove({ sessionIds: invocation.sessionIds });
  if (ctx) updateSubagentWidget(ctx, deps.agentManager.listSessions(), deps.getCurrentSettings());
  return toolResult({ view: "remove-summary", summary });
}

export async function runAction(
  deps: ActionDeps,
  invocation: InvocationFor<"run">,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
): Promise<ActionResult> {
  const parsed = invocation.tasks;
  const startOptions = deps.parentSessionId !== undefined
    ? { background: invocation.background === true, parentId: deps.parentSessionId }
    : { background: invocation.background === true };

  if (invocation.background === true) {
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
