import { defineTool, type AgentToolUpdateCallback, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Conversation, ConversationSnapshot } from "./conversation.js";
import { listAgentDefinitions, type AgentRegistry } from "./agents.js";
import type { ConversationId, RunId } from "./identifiers.js";
import type { OrderedStartOutcome, SubagentRuntime } from "./runtime.js";
import { parseSubagentInvocation, SubagentParams, type RunStatus, type SubagentAction, type SubagentInvocation, type SubagentInvocationParseError, type TaskRequest } from "./schema.js";
import type { SubagentSettings } from "./settings.js";
import {
  renderSubagentCall,
  renderSubagentResult,
  type JoinedRunRenderItem,
  type RunRenderItem,
  type SubagentToolDetails,
} from "./tool-renderer.js";

export interface ActionDeps {
  runtime: SubagentRuntime;
  agentRegistry: AgentRegistry;
  parent?: { conversationId: ConversationId; runId: () => RunId };
}

export interface ActionResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentToolDetails;
  isError?: boolean;
}

type InvocationFor<A extends SubagentAction> = Extract<SubagentInvocation, { action: A }>;

function jsonResult(json: unknown, details: SubagentToolDetails): ActionResult {
  return {
    content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
    details,
    isError: false,
  };
}

export function errorResult(message: string, requestedAction?: SubagentAction): ActionResult {
  return {
    content: [{ type: "text", text: message }],
    details: { action: "error", ...(requestedAction ? { requestedAction } : {}), message },
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
  return errorResult(message, parsed.action);
}

export function agentsAction(
  deps: ActionDeps,
  _invocation: InvocationFor<"agents">,
): ActionResult {
  const agents = listAgentDefinitions(deps.agentRegistry);
  return jsonResult({ agents }, { action: "agents", agents });
}

export function listAction(
  deps: ActionDeps,
  invocation: InvocationFor<"list">,
): ActionResult {
  const runs = deps.runtime.listConversations().flatMap(conversation =>
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
  return jsonResult(filtered, { action: "list", runs: filtered });
}

export function runAction(
  deps: ActionDeps,
  invocation: InvocationFor<"run">,
  ctx: ExtensionContext,
): ActionResult {
  const options = deps.parent
    ? { parent: { conversationId: deps.parent.conversationId, runId: deps.parent.runId() } }
    : {};
  const tasks: TaskRequest[] = [];
  const inputIndexes: number[] = [];
  const starts: OrderedStartOutcome[] = [];
  invocation.tasks.forEach((task, inputIndex) => {
    if ("error" in task) starts.push({ ok: false, inputIndex, error: task.error });
    else {
      tasks.push(task);
      inputIndexes.push(inputIndex);
    }
  });
  const handle = deps.runtime.startRun(ctx, tasks, options);
  starts.push(...handle.starts.map(start => ({
    ...start,
    inputIndex: inputIndexes[start.inputIndex],
  })));
  starts.sort((a, b) => a.inputIndex - b.inputIndex);
  return jsonResult(starts, {
    action: "run",
    tasks: renderRunItems(invocation.tasks, starts, conversationSnapshots(deps.runtime)),
  });
}

export async function joinAction(
  deps: ActionDeps,
  invocation: InvocationFor<"join">,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
): Promise<ActionResult> {
  let binding;
  try {
    binding = deps.runtime.bindJoin(invocation.runIds);
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
  const renderDetails = (): SubagentToolDetails => ({
    action: "join",
    runs: renderJoinedRuns(output(), conversationSnapshots(deps.runtime)),
  });
  const emit = () => onUpdate?.({
    content: [{ type: "text", text: JSON.stringify(output()) }],
    details: renderDetails(),
  });
  const unsubscribe = deps.runtime.onConversationUpdate(emit);
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
      ? deps.runtime.scheduler.suspendAgentSlotDuring(deps.parent.conversationId, wait)
      : wait());
    binding.acknowledge();
    const result = output();
    return jsonResult(result, {
      action: "join",
      runs: renderJoinedRuns(result, conversationSnapshots(deps.runtime)),
    });
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
  const result = deps.runtime.removeConversations(invocation.conversationIds);
  return jsonResult(result, { action: "remove", ...result });
}

function renderRunItems(
  tasks: readonly (TaskRequest | { error: string })[],
  starts: readonly OrderedStartOutcome[],
  conversations: readonly ConversationSnapshot[],
): RunRenderItem[] {
  const byConversation = new Map(conversations.map(conversation => [conversation.conversationId, conversation]));
  return starts.map(start => {
    const task = tasks[start.inputIndex];
    if (!task) return { inputIndex: start.inputIndex, error: "Task was not accepted." };
    if ("error" in task) return { inputIndex: start.inputIndex, error: task.error };
    const conversationId = start.ok
      ? start.conversationId
      : task.kind === "resume" ? task.conversationId : undefined;
    const conversation = conversationId ? byConversation.get(conversationId) : undefined;
    return {
      inputIndex: start.inputIndex,
      kind: task.kind,
      agent: task.kind === "spawn" ? task.agent : conversation?.config.name,
      label: task.kind === "spawn" ? task.label : conversation?.label,
      prompt: task.prompt,
      ...(start.ok ? { conversationId: start.conversationId, runId: start.runId } : { error: start.error }),
    };
  });
}

function conversationSnapshots(runtime: SubagentRuntime): ConversationSnapshot[] {
  const source = runtime as SubagentRuntime & { listConversations?: () => ConversationSnapshot[] };
  return typeof source.listConversations === "function" ? source.listConversations() : [];
}

type JoinedOutput = {
  conversationId: ConversationId;
  runId: RunId;
  status: RunStatus;
  output?: string;
  error?: string;
};

function renderJoinedRuns(
  output: readonly JoinedOutput[],
  conversations: readonly ConversationSnapshot[],
): JoinedRunRenderItem[] {
  const displayByRun = new Map(conversations.flatMap(conversation =>
    conversation.runs.map(run => [run.runId, {
      agent: conversation.config.name,
      label: conversation.label,
    }] as const),
  ));
  return output.map(run => ({ ...run, ...displayByRun.get(run.runId) }));
}

export interface SubagentToolDeps {
  runtime: SubagentRuntime;
  agentRegistry: AgentRegistry;
  /**
   * Called at the start of every tool invocation. Root extensions use this to reload settings,
   * reconfigure display, set max-concurrent, and reload the registry. Child factories provide
   * a no-op here because the parent's invocation already performed all of those steps.
   */
  prepareInvocation: (ctx: ExtensionContext) => Promise<SubagentSettings>;
  /** Releases notifier claims made by tool_execution_start after every join exit path. */
  releaseJoinClaims?: (runIds: readonly string[]) => void;
  /** Set on child factories; links spawned conversations and suspends its queue slot while joining. */
  parent?: { conversationId: ConversationId; runId: () => RunId };
}


export function defineSubagentTool(deps: SubagentToolDeps) {
  const { runtime, agentRegistry, prepareInvocation, parent } = deps;
  const actionDeps: ActionDeps = { runtime, agentRegistry, ...(parent ? { parent } : {}) };

  return defineTool<typeof SubagentParams, SubagentToolDetails>({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate work through context-isolated subagent conversations and runs. Subagents share the working filesystem.",
      "Actions:",
      "  agents(): List available agent definitions.",
      "  list(status?): List runs, optionally filtered by status.",
      "  run(tasks): Start asynchronous parallel tasks and immediately return their run IDs.",
      "  join(runIds): Wait for the given runs and return their outcomes in the same order.",
      "  remove(conversationIds): Remove retained conversations.",
      "Tasks:",
      "  Spawn: { agent, prompt, label?, skills?, model?, thinking?, cwd? }",
      "  Resume: { conversationId, prompt }",
    ].join("\n"),
    promptSnippet: "Delegate bounded work to context-isolated subagents",
    promptGuidelines: [
      "Delegate bounded, self-contained units of work to subagent — work that parallelizes cleanly, deserves a specialist, or benefits from a fresh context.",
      "Skip subagent when delegating costs more than doing, or when you couldn't verify or use the result without repeating the work.",
      "Write each subagent prompt as if to a stranger sharing only your filesystem: every input, path, and constraint, plus what to report back or produce.",
      "Run subagent tasks in parallel only when they're independent and won't interact with the same files; join once you depend on their results or have nothing else to do.",
      "Resume a retained subagent when its context helps the follow-up, spawn fresh when it wouldn't help or would mislead, and remove any you won't need again.",
      //"Call subagent action=agents before choosing an agent unless the user named one explicitly or definitions were already listed.",
    ],
    parameters: SubagentParams,
    renderCall(args, theme) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderSubagentResult(result, options, theme);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const requestedJoinIds = params?.action === "join" && Array.isArray(params.runIds)
        ? params.runIds.filter((id): id is string => typeof id === "string")
        : [];
      try {
        const settings = await prepareInvocation(ctx);

        const invocation = parseSubagentInvocation(params, { maxTasks: settings.runtime.maxTasksPerRun });
        if ("error" in invocation) return invocationErrorResult(actionDeps, invocation);

        switch (invocation.action) {
          case "agents": return agentsAction(actionDeps, invocation);
          case "list": return listAction(actionDeps, invocation);
          case "join": return joinAction(actionDeps, invocation, signal, onUpdate);
          case "remove": return removeAction(actionDeps, invocation);
          case "run": return runAction(actionDeps, invocation, ctx);
        }
      } finally {
        if (requestedJoinIds.length) deps.releaseJoinClaims?.(requestedJoinIds);
      }
    },
  });
}

export interface ChildToolDeps {
  manager: SubagentRuntime;
  registry: AgentRegistry;
  parent: Conversation;
  getCurrentSettings: () => SubagentSettings;
}

export function makeChildSubagentTool(deps: ChildToolDeps): ToolDefinition {
  const { manager, registry, parent, getCurrentSettings } = deps;
  return defineSubagentTool({
    runtime: manager,
    agentRegistry: registry,
    prepareInvocation: async () => getCurrentSettings(),
    parent: {
      conversationId: parent.conversationId,
      runId: () => parent.requireCurrentRun().runId,
    },
  });
}
