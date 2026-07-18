import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import type { SubagentSettings } from "../config/settings.js";
import type { SubagentAction, SubagentInvocation, SubagentInvocationParseError } from "../schema.js";
import { agentsDetails, type SubagentDetails } from "../view/details.js";
import { listAgentDefinitions, listAgentDefinitionsForModel } from "../view/serialize.js";

export interface ActionDeps { agentManager: AgentManager; agentRegistry: AgentRegistry; getCurrentSettings: () => SubagentSettings; parentConversationId?: string; parentRunId?: () => string }
export interface ActionResult { content: { type: "text"; text: string }[]; details: SubagentDetails; isError?: boolean }
type InvocationFor<A extends SubagentAction> = Extract<SubagentInvocation, { action: A }>;
function jsonResult(json: unknown, details: SubagentDetails = { view: "error" }): ActionResult { return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }], details, isError: false }; }
export function errorResult(message: string, extra: { errors?: string[] } = {}): ActionResult { return { content: [{ type: "text", text: message }], details: { view: "error", ...(extra.errors ? { errors: extra.errors } : {}) }, isError: true }; }
export function invocationErrorResult(deps: ActionDeps, parsed: SubagentInvocationParseError): ActionResult { const message = parsed.missingAction || parsed.taskCountError ? `${parsed.error}\n\nAvailable agents:\n${deps.agentRegistry.summarizeAgent()}` : parsed.error; return errorResult(message, parsed.errors ? { errors: parsed.errors } : {}); }
export function agentsAction(deps: ActionDeps, _invocation: InvocationFor<"agents">): ActionResult { return jsonResult({ agents: listAgentDefinitionsForModel(deps.agentRegistry) }, agentsDetails(listAgentDefinitions(deps.agentRegistry))); }
export function listAction(deps: ActionDeps, invocation: InvocationFor<"list">): ActionResult {
 const runs = deps.agentManager.listConversations().flatMap(c => c.runs.map(run => ({ conversationId: c.conversationId, runId: run.runId, agent: c.config.name, ...(c.label ? { label: c.label } : {}), kind: run.kind, status: run.status.kind === "done" ? run.status.outcome : run.status.kind, createdAt: run.createdAt })));
 const filtered = invocation.status ? runs.filter(r => invocation.status!.includes(r.status as any)) : runs;
 return jsonResult(filtered);
}
export function runAction(deps: ActionDeps, invocation: InvocationFor<"run">, ctx: ExtensionContext): ActionResult {
 const options = deps.parentConversationId ? { parentConversationId: deps.parentConversationId as any, parentRunId: deps.parentRunId?.() as any } : {};
 const handle = deps.agentManager.startRun(ctx, invocation.tasks, options);
 handle.completion.catch(() => {});
 return jsonResult(handle.starts);
}
export async function joinAction(deps: ActionDeps, invocation: InvocationFor<"join">, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined): Promise<ActionResult> {
 let binding;
 try { binding = deps.agentManager.bindJoin(invocation.runIds); } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
 // A join is a flat, ordered projection: each requested run, then that run's descendant runs.
 const project = (binding as { project?: typeof binding.project }).project;
 const selected = () => project?.call(binding) ?? deps.agentManager.listConversations().flatMap(c => c.runs.filter(r => invocation.runIds.includes(r.runId)).map(r => ({ conversationId: c.conversationId, runId: r.runId, status: r.status })));
 const output = () => selected().map(entry => entry.status.kind === "done"
   ? { conversationId: entry.conversationId, runId: entry.runId, status: entry.status.outcome, ...(entry.status.output !== undefined ? { output: entry.status.output } : {}), ...(entry.status.error !== undefined ? { error: entry.status.error } : {}) }
   : { conversationId: entry.conversationId, runId: entry.runId, status: entry.status.kind });
 const emit = () => onUpdate?.({ content: [{ type: "text", text: JSON.stringify(output()) }], details: { view: "error" } });
 const unsubscribe = deps.agentManager.onAgentUpdate(() => emit()); emit();
 let abort: (() => void) | undefined;
 const cancelled = signal ? new Promise<never>((_, reject) => { abort = () => reject(new Error("Join cancelled by caller.")); if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }) : undefined;
 try {
   const wait = () => cancelled ? Promise.race([binding.completion, cancelled]) : binding.completion;
   const outcomes = await (deps.parentConversationId ? deps.agentManager.runner.suspendAgentSlotDuring(deps.parentConversationId, wait) : wait());
   const result = project ? output() : outcomes.map((outcome, index) => ({ runId: invocation.runIds[index], ...outcome }));
   if (binding.acknowledge) binding.acknowledge();
   else deps.agentManager.acknowledgeRuns(invocation.runIds);
   return jsonResult(result);
 } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
 finally { unsubscribe(); binding.release(); if (abort) signal?.removeEventListener("abort", abort); }
}
export function removeAction(deps: ActionDeps, invocation: InvocationFor<"remove">): ActionResult { return jsonResult(deps.agentManager.removeConversations(invocation.conversationIds)); }
