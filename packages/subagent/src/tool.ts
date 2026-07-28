import { defineTool, type AgentToolUpdateCallback, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Conversation, ConversationSnapshot, NestedJoinAttemptSnapshot, RunSnapshot, SteerReceipt } from "./conversation.js";
import { listAgentDefinitions, type AgentRegistry } from "./agents.js";
import type { ConversationId, RunId } from "./identifiers.js";
import { runElapsedMs } from "./run-format.js";
import type { JoinBinding, NestedJoinBinding, SubagentRuntime } from "./runtime.js";
import { parseSubagentInvocation, SubagentParams, type RunRequest, type RunStatus, type SteerRequest, type SubagentAction, type SubagentInvocation, type SubagentInvocationParseError } from "./schema.js";
import type { SubagentSettings } from "./settings.js";
import {
  renderSubagentCall,
  renderSubagentResult,
  type JoinedRunRenderItem,
  type JoinInvocationRenderItem,
  type JoinTargetRenderItem,
  type DispatchTaskRenderItem,
  type InspectedRunRenderItem,
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

export interface SubagentSuccessEnvelope<A extends SubagentAction = SubagentAction, D = unknown> {
  action: A;
  ok: true;
  data: D;
}

export interface SubagentErrorEnvelope {
  action: SubagentAction | "unknown";
  ok: false;
  error: string;
}

export type SubagentResponseEnvelope<A extends SubagentAction = SubagentAction, D = unknown> =
  | SubagentSuccessEnvelope<A, D>
  | SubagentErrorEnvelope;

type InvocationFor<A extends SubagentAction> = Extract<SubagentInvocation, { action: A }>;
type OrderedDispatchOutcome =
  | { readonly ok: true; readonly inputIndex: number; readonly conversationId: ConversationId; readonly runId: RunId; readonly steer?: SteerReceipt }
  | { readonly ok: false; readonly inputIndex: number; readonly error: string };
type RunReceipt =
  | { readonly ok: true; readonly label?: string; readonly conversationId: ConversationId; readonly runId: RunId }
  | { readonly ok: false; readonly label?: string; readonly error: string };

function jsonResult(json: unknown, details: SubagentToolDetails): ActionResult {
  return {
    content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
    details,
    isError: false,
  };
}

function successEnvelope<A extends SubagentAction, D>(action: A, data: D): SubagentSuccessEnvelope<A, D> {
  return { action, ok: true, data };
}

function successResult<A extends SubagentAction, D>(action: A, data: D, details: SubagentToolDetails): ActionResult {
  return jsonResult(successEnvelope(action, data), details);
}

export function errorResult(message: string, requestedAction?: SubagentAction): ActionResult {
  const envelope: SubagentErrorEnvelope = {
    action: requestedAction ?? "unknown",
    ok: false,
    error: message,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
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
  return successResult("agents", { agents }, { action: "agents", agents });
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
  return successResult("list", { runs: filtered }, { action: "list", runs: filtered });
}

export async function runAction(
  deps: ActionDeps,
  invocation: InvocationFor<"run">,
  ctx: ExtensionContext,
): Promise<ActionResult> {
  const owner = deps.parent
    ? { conversationId: deps.parent.conversationId, runId: deps.parent.runId() }
    : undefined;
  const tasks = [...invocation.spawns, ...invocation.resumes];
  const outcomes: OrderedDispatchOutcome[] = [];

  for (let inputIndex = 0; inputIndex < tasks.length; inputIndex++) {
    const task = tasks[inputIndex];
    if ("error" in task) {
      outcomes.push({ ok: false, inputIndex, error: task.error });
      continue;
    }
    const handle = deps.runtime.startRun(ctx, [task], owner ? { parent: owner } : {});
    outcomes.push({ ...handle.starts[0], inputIndex });
  }

  const conversations = conversationSnapshots(deps.runtime);
  const receipts = outcomes.map((outcome, index) => projectRunReceipt(tasks[index], outcome, conversations));
  return successResult("run", {
    spawns: receipts.slice(0, invocation.spawns.length),
    resumes: receipts.slice(invocation.spawns.length),
  }, {
    action: "run",
    tasks: renderDispatchItems(tasks, outcomes, conversations),
  });
}

export async function steerAction(
  deps: ActionDeps,
  invocation: InvocationFor<"steer">,
): Promise<ActionResult> {
  const owner = deps.parent
    ? { conversationId: deps.parent.conversationId, runId: deps.parent.runId() }
    : undefined;
  const outcomes: OrderedDispatchOutcome[] = [];

  for (let inputIndex = 0; inputIndex < invocation.messages.length; inputIndex++) {
    const steer = invocation.messages[inputIndex];
    if ("error" in steer) {
      outcomes.push({ ok: false, inputIndex, error: steer.error });
      continue;
    }
    try {
      const result = await deps.runtime.steerRun(steer.runId, steer.message, owner);
      outcomes.push({ ok: true, inputIndex, ...result });
    } catch (error) {
      outcomes.push({ ok: false, inputIndex, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return successResult("steer", { messages: outcomes }, {
    action: "steer",
    tasks: renderDispatchItems(invocation.messages, outcomes, conversationSnapshots(deps.runtime)),
  });
}

export async function cancelAction(
  deps: ActionDeps,
  invocation: InvocationFor<"cancel">,
): Promise<ActionResult> {
  const owner = deps.parent
    ? { conversationId: deps.parent.conversationId, runId: deps.parent.runId() }
    : undefined;
  const runs = [];

  for (const target of invocation.runIds) {
    if (typeof target !== "string") {
      runs.push({ runId: target.runId, error: target.error });
      continue;
    }
    try {
      runs.push(await deps.runtime.cancelRun(target, owner));
    } catch (error) {
      runs.push({ runId: target, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return successResult("cancel", { runs }, { action: "cancel", runs });
}

export function inspectAction(
  deps: ActionDeps,
  invocation: InvocationFor<"inspect">,
): ActionResult {
  const owner = deps.parent
    ? { conversationId: deps.parent.conversationId, runId: deps.parent.runId() }
    : undefined;
  const runs = invocation.runIds.map((target, inputIndex) => {
    if (typeof target !== "string") return { inputIndex, runId: target.runId, error: target.error };
    try {
      const inspected = deps.runtime.inspectRuns([target], owner)[0];
      return projectInspection(deps.runtime, inspected.conversationId, inspected.snapshot);
    } catch (error) {
      return { inputIndex, runId: target, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return successResult("inspect", { runs }, { action: "inspect", runs });
}

export async function joinAction(
  deps: ActionDeps,
  invocation: InvocationFor<"join">,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  toolCallId?: string,
): Promise<ActionResult> {
  const owner = deps.parent
    ? { conversationId: deps.parent.conversationId, runId: deps.parent.runId() }
    : undefined;
  const targets = invocation.runIds.map(target => {
    if (typeof target !== "string") return target;
    try {
      deps.runtime.inspectRuns([target], owner);
      return target;
    } catch (error) {
      return { runId: target, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const validRunIds = targets.filter((target): target is RunId => typeof target === "string");

  if (validRunIds.length === 0) {
    const result = targets as JoinOutput[];
    return successResult("join", { runs: result }, { action: "join", runs: renderJoinedRuns(result, deps.runtime, true) });
  }

  let binding: JoinBinding | NestedJoinBinding;
  try {
    binding = owner
      ? deps.runtime.bindNestedJoin(owner, validRunIds, toolCallId)
      : deps.runtime.bindJoin(validRunIds);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error), "join");
  }

  const output = (): JoinOutput[] => {
    const entries = binding.project();
    let entryIndex = 0;
    return targets.map(target => typeof target === "string"
      ? projectJoinedEntry(entries[entryIndex++])
      : target);
  };
  const renderDetails = (final = false): SubagentToolDetails => ({
    action: "join",
    runs: renderJoinedRuns(output(), deps.runtime, final),
  });
  const emit = () => onUpdate?.({
    content: [{ type: "text", text: JSON.stringify(successEnvelope("join", { runs: output() })) }],
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
    return successResult("join", { runs: result }, renderDetails(true));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (owner) (binding as NestedJoinBinding).interrupt(message);
    return errorResult(message, "join");
  } finally {
    unsubscribe();
    binding.release();
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function projectJoinedEntry(entry: ReturnType<JoinBinding["project"]>[number]): JoinedOutput {
  return entry.status.kind === "done"
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
      };
}

export async function removeAction(
  deps: ActionDeps,
  invocation: InvocationFor<"remove">,
): Promise<ActionResult> {
  const result = await deps.runtime.removeConversations(invocation.conversationIds);
  return successResult("remove", {
    removed: result.removed,
    conversations: result.conversationIds,
    errors: result.errors,
  }, { action: "remove", ...result });
}

function projectRunReceipt(
  task: RunRequest | { error: string; label?: string } | undefined,
  outcome: OrderedDispatchOutcome,
  conversations: readonly ConversationSnapshot[],
): RunReceipt {
  const label = task && "error" in task
    ? task.label
    : task?.kind === "spawn"
      ? task.label
      : task?.kind === "resume"
        ? conversations.find(conversation => conversation.conversationId === task.conversationId)?.label
        : undefined;
  return outcome.ok
    ? { ok: true, ...(label ? { label } : {}), conversationId: outcome.conversationId, runId: outcome.runId }
    : { ok: false, ...(label ? { label } : {}), error: outcome.error };
}

function renderDispatchItems(
  tasks: readonly (RunRequest | SteerRequest | { error: string; label?: string })[],
  starts: readonly OrderedDispatchOutcome[],
  conversations: readonly ConversationSnapshot[],
): DispatchTaskRenderItem[] {
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
      prompt: task.kind === "steer" ? task.message : task.prompt,
      ...(start.ok
        ? { conversationId: start.conversationId, runId: start.runId, ...(start.steer ? { steer: start.steer } : {}) }
        : { error: start.error }),
    };
  });
}

function projectInspection(
  runtime: SubagentRuntime,
  conversationId: ConversationId,
  run: RunSnapshot,
): InspectedRunRenderItem {
  const status = run.status.kind === "done" ? run.status.outcome : run.status.kind;
  const end = run.status.kind === "done" ? run.status.completedAt : Date.now();
  const start = run.status.kind === "queued" ? run.status.queuedAt
    : run.status.kind === "running" ? run.status.startedAt
    : run.status.startedAt ?? run.createdAt;
  let display: { agentName?: string; label?: string } = {};
  try { display = runtime.conversationDisplay(conversationId); } catch {}
  return {
    conversationId,
    runId: run.runId,
    ...(display.agentName ? { agent: display.agentName } : {}),
    ...(display.label ? { label: display.label } : {}),
    status,
    ...(status === "running" ? { phase: run.activity.phase } : {}),
    elapsedMs: Math.max(0, end - start),
    turns: run.activity.turns,
    compactions: run.activity.compactions,
    ...(status === "running" && run.activity.messageSnippet
      ? { messageSnippet: truncateInspectionText(run.activity.messageSnippet, 500) }
      : {}),
    ...(run.status.kind === "done" && run.status.error
      ? { errorSnippet: truncateInspectionText(run.status.error, 500) }
      : {}),
    recentTools: run.activity.toolHistory.slice(-3).reverse().map(tool => ({
      toolCallId: tool.id,
      tool: tool.name,
      ...(tool.inputSummary ? { summary: truncateInspectionText(tool.inputSummary, 160) } : {}),
      status: tool.completedAt === undefined
        ? run.status.kind === "done" ? "interrupted" : "running"
        : tool.isError ? "error" : "completed",
    })),
    steers: (run.steers ?? []).slice(-5),
  };
}

function truncateInspectionText(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
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
type JoinOutputError = { runId: string; error: string };
type JoinOutput = JoinedOutput | JoinOutputError;

function renderJoinedRuns(
  output: readonly JoinOutput[],
  runtime: SubagentRuntime,
  final: boolean,
): JoinedRunRenderItem[] {
  const conversations = conversationSnapshots(runtime);
  const byRun = new Map(conversations.flatMap(conversation => conversation.runs.map(run =>
    [run.runId, { conversation, run }] as const)));
  const snapshot = (runId: RunId): RunSnapshot | undefined => {
    try { return runtime.runSnapshot?.(runId) ?? byRun.get(runId)?.run; } catch { return byRun.get(runId)?.run; }
  };
  const display = (conversationId: ConversationId | undefined) => {
    if (!conversationId) return {};
    const local = conversations.find(item => item.conversationId === conversationId);
    if (local) return { agent: local.config.name, ...(local.label ? { label: local.label } : {}) };
    try {
      const value = runtime.conversationDisplay(conversationId);
      return { ...(value.agentName ? { agent: value.agentName } : {}), ...(value.label ? { label: value.label } : {}) };
    } catch { return {}; }
  };
  const status = (run: RunSnapshot): RunStatus => run.status.kind === "done" ? run.status.outcome : run.status.kind;
  const activity = (run: RunSnapshot) => run.activity.toolHistory.map(tool => ({
    toolCallId: tool.id, tool: tool.name, ...(tool.inputSummary ? { summary: tool.inputSummary } : {}),
  }));
  const background = (ownerRunId: RunId, ownerLabel?: string) => {
    let children: readonly { runId: RunId; conversationId: ConversationId }[] = [];
    try { children = runtime.unjoinedDirectChildren(ownerRunId); } catch { return []; }
    if (!children.length) return [];
    return [{ ownerRunId, ...(ownerLabel ? { ownerLabel } : {}), entries: children.map(child => {
      const childRun = snapshot(child.runId);
      const childStatus = childRun ? status(childRun) : "running";
      return { conversationId: child.conversationId, runId: child.runId, ...display(child.conversationId), status: childStatus,
        ...(final && (childStatus === "queued" || childStatus === "running") ? { detachedAtFinal: true } : {}) };
    }) }];
  };
  const target = (value: NestedJoinAttemptSnapshot["targets"][number]): JoinTargetRenderItem => {
    const run = snapshot(value.runId);
    const targetStatus = (run ? status(run) : value.status ?? "error") as RunStatus;
    const base: JoinTargetRenderItem = { runId: value.runId, ...(value.conversationId ? { conversationId: value.conversationId, ...display(value.conversationId) } : {}), status: targetStatus };
    if (!run) return base;
    return {
      ...base,
      ...runStats(run),
      activity: activity(run),
      joins: joins(run),
      background: background(run.runId, base.label ?? base.agent),
      ...(run.status.kind === "done" && run.status.error ? { error: run.status.error } : {}),
    };
  };
  const joins = (run: RunSnapshot): JoinInvocationRenderItem[] => (run.nestedJoins ?? []).map(attempt => ({
    status: (attempt.state === "running" ? "running" : attempt.state === "completed" ? "completed" : attempt.state === "interrupted" ? "interrupted" : "error") as RunStatus,
    targets: attempt.targets.map(target), ...(attempt.error ? { error: attempt.error } : {}), ...(attempt.toolCallId ? { toolCallId: attempt.toolCallId } : {}),
  }));
  return output.map(value => {
    if (!("status" in value)) return { ...value, status: "error" };
    const run = snapshot(value.runId);
    if (!run) return { ...value };
    const info = display(value.conversationId);
    const represented = (run.nestedJoins ?? []).flatMap(attempt => attempt.toolCallId ? [attempt.toolCallId] : []);
    return { ...value, ...info, kind: run.kind, prompt: run.prompt, ...runStats(run), activity: activity(run), joins: joins(run),
      background: background(run.runId, info.label ?? info.agent), joinToolCallIds: represented };
  });
}

function runStats(run: RunSnapshot): Pick<JoinedRunRenderItem, "elapsedMs" | "turns" | "tokens"> {
  return {
    elapsedMs: runElapsedMs(run),
    turns: run.activity.turns,
    tokens: run.usage?.totalTokens ?? 0,
  };
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
      "Conversation IDs use adjective-noun form; run IDs use verb-adverb form.",
      "Results use { action, ok, data } on success or { action, ok, error } on global failure.",
      "Actions:",
      "  agents(): List available agent definitions.",
      "  list(status?): List runs, optionally filtered by status.",
      "  run(spawns?, resumes?): Start asynchronous spawn and resume tasks.",
      "  steer(messages): Send messages to running subagents.",
      "  inspect(runIds): Check run status and progress without waiting.",
      "  join(runIds): Wait for the given runs and return their outcomes.",
      "  cancel(runIds): Abort active runs while retaining their conversations and outcomes.",
      "  remove(conversationIds): Delete terminal conversations and their runs.",
    ].join("\n"),
    promptSnippet: "Delegate bounded work to context-isolated subagents",
    promptGuidelines: [
      "Delegate bounded, self-contained units of work to subagent — work that parallelizes cleanly, deserves a specialist, or benefits from a fresh context.",
      "Skip subagent when delegating costs more than doing, or when you couldn't verify or use the result without repeating the work.",
      "Write each subagent prompt as if to a stranger sharing only your filesystem: every input, path, and constraint, plus what to report back or produce.",
      "Run subagent tasks in parallel only when they're independent and won't interact with the same files; join once you depend on their results or have nothing else to do.",
      "Use subagent inspect only when progress could affect your next step; steer only to communicate newly discovered constraints or correct clear divergence.",
      "Resume a retained subagent when its context helps the follow-up, spawn fresh when it wouldn't help or would mislead, and permanently remove terminal conversations you no longer need.",
      //"Call subagent action=agents before choosing an agent unless the user named one explicitly or definitions were already listed.",
    ],
    parameters: SubagentParams,
    renderCall(args, theme) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderSubagentResult(result, options, theme);
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
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
          case "run": return runAction(actionDeps, invocation, ctx);
          case "steer": return steerAction(actionDeps, invocation);
          case "cancel": return cancelAction(actionDeps, invocation);
          case "inspect": return inspectAction(actionDeps, invocation);
          case "join": return joinAction(actionDeps, invocation, signal, onUpdate, toolCallId);
          case "remove": return removeAction(actionDeps, invocation);
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
