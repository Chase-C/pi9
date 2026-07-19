import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { ConversationId } from "../domain/conversation-id.js";
import type { RunId } from "../domain/run-id.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import type { RunStatus, SubagentAction, SubagentInvocation, SubagentInvocationParseError } from "../schema.js";
import { listAgentDefinitions } from "../view/serialize.js";

export interface ActionDeps {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  parent?: { conversationId: ConversationId; runId: () => RunId };
}

export interface ActionResult {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
  isError?: boolean;
}

type InvocationFor<A extends SubagentAction> = Extract<SubagentInvocation, { action: A }>;

function jsonResult(json: unknown): ActionResult {
  return {
    content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
    details: undefined,
    isError: false,
  };
}

export function errorResult(message: string): ActionResult {
  return {
    content: [{ type: "text", text: message }],
    details: undefined,
    isError: true,
  };
}

export function invocationErrorResult(
  deps: ActionDeps,
  parsed: SubagentInvocationParseError,
): ActionResult {
  const message = parsed.missingAction || parsed.taskCountError
    ? `${parsed.error}\n\nAvailable agents:\n${deps.agentRegistry.summarizeAgent()}`
    : parsed.error;
  return errorResult(message);
}

export function agentsAction(
  deps: ActionDeps,
  _invocation: InvocationFor<"agents">,
): ActionResult {
  return jsonResult({ agents: listAgentDefinitions(deps.agentRegistry) });
}

export function listAction(
  deps: ActionDeps,
  invocation: InvocationFor<"list">,
): ActionResult {
  const runs = deps.agentManager.listConversations().flatMap(conversation =>
    conversation.runs.map(run => ({
      conversationId: conversation.conversationId,
      runId: run.runId,
      agent: conversation.config.name,
      ...(conversation.label ? { label: conversation.label } : {}),
      kind: run.kind,
      status: (run.status.kind === "done" ? run.status.outcome : run.status.kind) as RunStatus,
      createdAt: run.createdAt,
    })),
  );
  const filtered = invocation.status
    ? runs.filter(run => invocation.status!.includes(run.status))
    : runs;
  return jsonResult(filtered);
}

export function runAction(
  deps: ActionDeps,
  invocation: InvocationFor<"run">,
  ctx: ExtensionContext,
): ActionResult {
  const options = deps.parent
    ? { parent: { conversationId: deps.parent.conversationId, runId: deps.parent.runId() } }
    : {};
  const handle = deps.agentManager.startRun(ctx, invocation.tasks, options);
  return jsonResult(handle.starts);
}

export async function joinAction(
  deps: ActionDeps,
  invocation: InvocationFor<"join">,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<undefined> | undefined,
): Promise<ActionResult> {
  let binding;
  try {
    binding = deps.agentManager.bindJoin(invocation.runIds);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const output = () => binding.project().map(entry => entry.status.kind === "done"
    ? {
        conversationId: entry.conversationId,
        runId: entry.runId,
        status: entry.status.outcome,
        ...(entry.status.output !== undefined ? { output: entry.status.output } : {}),
        ...(entry.status.error !== undefined ? { error: entry.status.error } : {}),
      }
    : {
        conversationId: entry.conversationId,
        runId: entry.runId,
        status: entry.status.kind,
      });
  const emit = () => onUpdate?.({
    content: [{ type: "text", text: JSON.stringify(output()) }],
    details: undefined,
  });
  const unsubscribe = deps.agentManager.onAgentUpdate(emit);
  emit();

  let abort: (() => void) | undefined;
  const cancelled = signal
    ? new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Join cancelled by caller."));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      })
    : undefined;

  try {
    const wait = () => cancelled
      ? Promise.race([binding.completion, cancelled])
      : binding.completion;
    await (deps.parent
      ? deps.agentManager.runner.suspendAgentSlotDuring(deps.parent.conversationId, wait)
      : wait());
    binding.acknowledge();
    return jsonResult(output());
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  } finally {
    unsubscribe();
    binding.release();
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export function removeAction(
  deps: ActionDeps,
  invocation: InvocationFor<"remove">,
): ActionResult {
  return jsonResult(deps.agentManager.removeConversations(invocation.conversationIds));
}
