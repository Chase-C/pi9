import { defineTool, type AgentToolUpdateCallback, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { effectiveStatus, type Conversation, type ConversationSnapshot, type NestedJoinAttemptSnapshot, type RunSnapshot, type SteerReceipt } from "./conversation.js";
import { projectSubagentStatus, type CanonicalLiveSubagent, type FailureProjectionMode } from "./contract.js";
import { listAgentDefinitions, type AgentRegistry } from "./agents.js";
import type { ConversationId, RunId, SubagentId } from "./identifiers.js";
import { runElapsedMs, truncateText } from "./run-format.js";
import { SubagentNotFoundError, type JoinBinding, type NestedJoinBinding, type SubagentCaller, type SubagentRuntime } from "./runtime.js";
import type { RunScheduler } from "./scheduler.js";
import { parseSubagentInvocation, SubagentParams, type RunRequest, type RunStatus, type SteerRequest, type SubagentAction, type SubagentInvocation, type SubagentInvocationParseError, type SubagentStatus } from "./schema.js";
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

export interface ActionRuntime {
  queryConversations: SubagentRuntime["queryConversations"];
  conversationDepth: SubagentRuntime["conversationDepth"];
  listConversations: SubagentRuntime["listConversations"];
  startRun: SubagentRuntime["startRun"];
  steerSubagent: SubagentRuntime["steerSubagent"];
  cancelSubagent: SubagentRuntime["cancelSubagent"];
  inspectSubagents: SubagentRuntime["inspectSubagents"];
  validateSubagentJoin: SubagentRuntime["validateSubagentJoin"];
  bindSubagentJoin: SubagentRuntime["bindSubagentJoin"];
  onConversationUpdate: SubagentRuntime["onConversationUpdate"];
  removeConversations: SubagentRuntime["removeConversations"];
  conversation: SubagentRuntime["conversation"];
  conversationDisplay: SubagentRuntime["conversationDisplay"];
  projectSubagent: SubagentRuntime["projectSubagent"];
  runSnapshot: SubagentRuntime["runSnapshot"];
  unjoinedDirectChildren: SubagentRuntime["unjoinedDirectChildren"];
  scheduler: Pick<RunScheduler, "suspendAgentSlotDuring">;
}

export interface ActionDeps {
  runtime: ActionRuntime;
  agentRegistry: AgentRegistry;
  parent?: { conversationId: ConversationId; runId: () => RunId };
}

export interface ActionResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentToolDetails;
}

export interface SubagentResultsEnvelope<A extends SubagentAction = SubagentAction, T = unknown> {
  action: A;
  results: T[];
}

export interface SubagentErrorEnvelope {
  action: SubagentAction | "unknown";
  error: string;
}

export type SubagentResponseEnvelope<A extends SubagentAction = SubagentAction, T = unknown> =
  | SubagentResultsEnvelope<A, T>
  | SubagentErrorEnvelope;

export type ItemResult<T extends object, I extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | ({ ok: false; error: string; code?: string } & I);

type InvocationFor<A extends SubagentAction> = Extract<SubagentInvocation, { action: A }>;
type OrderedDispatchOutcome =
  | { readonly ok: true; readonly inputIndex: number; readonly conversationId: ConversationId; readonly runId: RunId; readonly steer?: SteerReceipt }
  | { readonly ok: false; readonly inputIndex: number; readonly error: string; readonly code?: string };
function callerOf(deps: ActionDeps): SubagentCaller | undefined {
  return deps.parent
    ? { conversationId: deps.parent.conversationId, runId: deps.parent.runId() }
    : undefined;
}

type ResultIdentity = { readonly agent?: string; readonly label?: string };
type DescendantSummary = {
  readonly subagentId: ConversationId;
  readonly label: string;
  readonly agent: string;
  readonly status: CanonicalLiveSubagent["status"];
  readonly descendants?: DescendantSummary[];
};

function actionFailure(error: unknown): { error: string; code?: string } {
  return error instanceof SubagentNotFoundError
    ? { error: error.message, code: error.code }
    : { error: error instanceof Error ? error.message : String(error) };
}

function canonicalSubagent(
  deps: ActionDeps,
  conversationId: ConversationId,
  failureMode: FailureProjectionMode = "full",
): CanonicalLiveSubagent {
  return deps.runtime.projectSubagent(conversationId, callerOf(deps), failureMode);
}

function targetFailure(
  deps: ActionDeps,
  subagentId: string,
  error: unknown,
): { ok: false; subagentId: string; error: string; code?: string } & Partial<Omit<CanonicalLiveSubagent, "ok" | "subagentId">> {
  const failure = actionFailure(error);
  try {
    const { ok: _, ...live } = deps.runtime.projectSubagent(subagentId, callerOf(deps), { maxLength: 500 });
    return { ok: false, ...live, error: failure.error, ...(failure.code ? { code: failure.code } : {}) };
  } catch {
    return { ok: false, subagentId, error: failure.error, ...(failure.code ? { code: failure.code } : {}) };
  }
}

type RunReceipt = ItemResult<{
  readonly agent: string;
  readonly label: string;
  readonly subagentId: ConversationId;
  readonly status: CanonicalLiveSubagent["status"];
  readonly joined?: boolean;
  readonly availableActions: CanonicalLiveSubagent["availableActions"];
  readonly failure?: string;
}, {
  readonly agent?: string;
  readonly label?: string;
  readonly subagentId?: string;
}>;

function resultsEnvelope<A extends SubagentAction, T>(action: A, results: T[]): SubagentResultsEnvelope<A, T> {
  return { action, results };
}

function resultsResult<A extends SubagentAction, T>(action: A, results: T[], details: SubagentToolDetails): ActionResult {
  return {
    content: [{ type: "text", text: JSON.stringify(resultsEnvelope(action, results), null, 2) }],
    details,
  };
}

export function errorResult(message: string, requestedAction?: SubagentAction): ActionResult {
  const envelope: SubagentErrorEnvelope = {
    action: requestedAction ?? "unknown",
    error: message,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    details: { action: "error", ...(requestedAction ? { requestedAction } : {}), message },
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
  return resultsResult("agents", agents.map(agent => ({ ok: true as const, ...agent })), { action: "agents", agents });
}

export function listAction(
  deps: ActionDeps,
  invocation: InvocationFor<"list">,
): ActionResult {
  const callerConversationId = deps.parent?.conversationId;
  const all = deps.runtime.listConversations();
  const descendants = (parentId: ConversationId): DescendantSummary[] =>
    all.filter(item => item.parentConversationId === parentId).map(item => {
      const children = descendants(item.conversationId);
      return {
        subagentId: item.conversationId,
        label: item.label,
        agent: item.config.name,
        status: deps.runtime.projectSubagent(item.conversationId, callerOf(deps)).status,
        ...(children.length ? { descendants: children } : {}),
      };
    });
  const conversations = deps.runtime.queryConversations(callerConversationId)
    .map(conversation => ({
      ...canonicalSubagent(deps, conversation.conversationId, { maxLength: 500 }),
      descendants: descendants(conversation.conversationId),
    }))
    .filter(conversation => !invocation.statuses || invocation.statuses.includes(conversation.status))
    .filter(conversation => invocation.joined === undefined || conversation.joined === invocation.joined);
  return resultsResult("list", conversations, { action: "list", conversations });
}

export async function spawnAction(
  deps: ActionDeps,
  invocation: InvocationFor<"spawn">,
  ctx: ExtensionContext,
): Promise<ActionResult> {
  return startTasks(deps, "spawn", invocation.spawns, ctx);
}

export async function resumeAction(
  deps: ActionDeps,
  invocation: InvocationFor<"resume">,
  ctx: ExtensionContext,
): Promise<ActionResult> {
  return startTasks(deps, "resume", invocation.resumes, ctx);
}

async function startTasks(
  deps: ActionDeps,
  action: "spawn" | "resume",
  tasks: InvocationFor<"spawn">["spawns"] | InvocationFor<"resume">["resumes"],
  ctx: ExtensionContext,
): Promise<ActionResult> {
  const owner = callerOf(deps);
  const outcomes: OrderedDispatchOutcome[] = [];
  const validTasks: RunRequest[] = [];
  const validIndexes: number[] = [];

  for (let inputIndex = 0; inputIndex < tasks.length; inputIndex++) {
    const task = tasks[inputIndex];
    if ("error" in task) outcomes.push({ ok: false, inputIndex, error: task.error });
    else { validTasks.push(task); validIndexes.push(inputIndex); }
  }
  if (validTasks.length) {
    const handle = deps.runtime.startRun(ctx, validTasks, owner ? { caller: owner } : {});
    for (const start of handle.starts) outcomes.push({ ...start, inputIndex: validIndexes[start.inputIndex] });
  }
  outcomes.sort((left, right) => left.inputIndex - right.inputIndex);

  const conversations = deps.runtime.listConversations();
  const receipts = outcomes.map(outcome => projectRunReceipt(deps, tasks[outcome.inputIndex], outcome));
  return resultsResult(action, receipts, {
    action,
    tasks: renderDispatchItems(tasks, outcomes, conversations),
  });
}

export async function steerAction(
  deps: ActionDeps,
  invocation: InvocationFor<"steer">,
): Promise<ActionResult> {
  const owner = callerOf(deps);
  const outcomes: OrderedDispatchOutcome[] = [];

  for (let inputIndex = 0; inputIndex < invocation.messages.length; inputIndex++) {
    const steer = invocation.messages[inputIndex];
    if ("error" in steer) {
      outcomes.push({ ok: false, inputIndex, error: steer.error });
      continue;
    }
    try {
      const result = await deps.runtime.steerSubagent(steer.subagentId, steer.message, owner);
      outcomes.push({ ok: true, inputIndex, ...result });
    } catch (error) {
      outcomes.push({ ok: false, inputIndex, ...actionFailure(error) });
    }
  }

  const results = outcomes.map((outcome, index) => {
    const target = invocation.messages[index]?.subagentId;
    return outcome.ok
      ? { ...canonicalSubagent(deps, outcome.conversationId), ...(outcome.steer ? { steer: outcome.steer } : {}) }
      : target
        ? { ...targetFailure(deps, target, outcome.error), ...(outcome.code ? { code: outcome.code } : {}) }
        : { ok: false as const, error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) };
  });
  return resultsResult("steer", results, {
    action: "steer",
    tasks: renderDispatchItems(invocation.messages, outcomes, deps.runtime.listConversations()),
  });
}

export async function cancelAction(
  deps: ActionDeps,
  invocation: InvocationFor<"cancel">,
): Promise<ActionResult> {
  const owner = callerOf(deps);
  const runs = await Promise.all(invocation.subagentIds.map(async target => {
    if (typeof target !== "string") return { ok: false as const, subagentId: target.subagentId, error: target.error };
    try {
      const result = await deps.runtime.cancelSubagent(target as SubagentId, owner);
      return canonicalSubagent(deps, result.conversationId);
    } catch (error) {
      return targetFailure(deps, target, error);
    }
  }));

  const results = runs;
  return resultsResult("cancel", results, { action: "cancel", runs });
}

export function inspectAction(
  deps: ActionDeps,
  invocation: InvocationFor<"inspect">,
): ActionResult {
  const owner = callerOf(deps);
  const runs = invocation.subagentIds.map(target => {
    if (typeof target !== "string") return { ok: false as const, subagentId: target.subagentId, error: target.error };
    try {
      const inspected = deps.runtime.inspectSubagents([target as SubagentId], owner)[0];
      const diagnostics = projectInspection(deps.runtime, inspected.conversationId, inspected.snapshot, owner?.conversationId);
      return { ...canonicalSubagent(deps, inspected.conversationId, { maxLength: 500 }), ...diagnostics };
    } catch (error) {
      return targetFailure(deps, target, error);
    }
  });
  return resultsResult("inspect", runs, { action: "inspect", runs });
}

export async function joinAction(
  deps: ActionDeps,
  invocation: InvocationFor<"join">,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  toolCallId?: string,
): Promise<ActionResult> {
  const owner = callerOf(deps);
  const targets = invocation.subagentIds.map(target => {
    if (typeof target !== "string") return target;
    try {
      deps.runtime.validateSubagentJoin(target as SubagentId, owner);
      return target;
    } catch (error) {
      return { subagentId: target, ...actionFailure(error) };
    }
  });
  const validSubagentIds = targets.filter((target): target is SubagentId => typeof target === "string");

  if (validSubagentIds.length === 0) {
    const result = targets as JoinOutput[];
    return resultsResult("join", projectJoinResults(result, deps), { action: "join", runs: renderJoinedRuns(result, deps.runtime, true) });
  }

  let binding: JoinBinding | NestedJoinBinding;
  try {
    binding = deps.runtime.bindSubagentJoin(validSubagentIds, owner, toolCallId);
  } catch (error) {
    const results = targets.map(target => typeof target === "string"
      ? targetFailure(deps, target, error)
      : targetFailure(deps, target.subagentId, target.error));
    return resultsResult("join", results, { action: "join", runs: renderJoinedRuns(targets as JoinOutput[], deps.runtime, true) });
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
    content: [{ type: "text", text: JSON.stringify(resultsEnvelope("join", projectJoinResults(output(), deps))) }],
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
    binding.markJoined();
    const result = output();
    return resultsResult("join", projectJoinResults(result, deps), renderDetails(true));
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
        subagentId: entry.conversationId,
        runId: entry.runId,
        status: entry.status.outcome,
        ...(entry.status.output !== undefined ? { output: entry.status.output } : {}),
        ...(entry.status.error !== undefined ? { error: entry.status.error } : {}),
      }
    : {
        subagentId: entry.conversationId,
        runId: entry.runId,
        status: entry.status.kind,
      };
}

export async function removeAction(
  deps: ActionDeps,
  invocation: InvocationFor<"remove">,
): Promise<ActionResult> {
  const validIds = invocation.subagentIds.filter((target): target is ConversationId => typeof target === "string");
  const caller = callerOf(deps);
  const removed = await deps.runtime.removeConversations(validIds, caller);
  const results = invocation.subagentIds.map(target => {
    if (typeof target !== "string") return { ok: false as const, subagentId: target.subagentId, error: target.error };
    const removal = removed.removals.find(item => item.conversationId === target);
    if (removal) {
      return {
        ok: true as const,
        subagentId: target,
        label: removal.label!,
        removedIds: removal.conversationIds,
      };
    }
    const failure = removed.errors.find(item => item.conversationId === target);
    return {
      ok: false as const,
      subagentId: target,
      error: failure?.error ?? `Subagent ${target} was not removed.`,
      ...(failure?.code ? { code: failure.code } : {}),
    };
  });
  const parseErrors = invocation.subagentIds.flatMap(target => typeof target === "string"
    ? []
    : [{ subagentId: target.subagentId, error: target.error }]);
  return resultsResult("remove", results, {
    action: "remove",
    removed: removed.removed,
    subagentIds: removed.conversationIds,
    errors: [...parseErrors, ...removed.errors.map(error => ({ subagentId: error.conversationId, error: error.error }))],
  });
}

function projectRunReceipt(
  deps: ActionDeps,
  task: RunRequest | { error: string; agent?: string; label?: string; subagentId?: string } | undefined,
  outcome: OrderedDispatchOutcome,
): RunReceipt {
  if (outcome.ok) return canonicalSubagent(deps, outcome.conversationId);

  if (task && !("error" in task) && task.kind === "resume") {
    return { ...targetFailure(deps, task.subagentId, outcome.error), ...(outcome.code ? { code: outcome.code } : {}) };
  }
  const identity = !task
    ? {}
    : "error" in task
      ? {
          ...(task.agent ? { agent: task.agent } : {}),
          ...(task.label ? { label: task.label } : {}),
          ...(task.subagentId ? { subagentId: task.subagentId } : {}),
        }
      : { agent: task.agent, label: task.label };
  return { ok: false, ...identity, error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) };
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
      : task.kind === "resume" ? task.subagentId : undefined;
    const conversation = conversationId ? byConversation.get(conversationId) : undefined;
    return {
      inputIndex: start.inputIndex,
      kind: task.kind,
      agent: task.kind === "spawn" ? task.agent : conversation?.config.name,
      label: task.kind === "spawn" ? task.label : conversation?.label,
      prompt: task.kind === "steer" ? task.message : task.prompt,
      ...(start.ok
        ? { subagentId: start.conversationId, ...(start.steer ? { steer: start.steer } : {}) }
        : { error: start.error }),
    };
  });
}

function projectInspection(
  runtime: ActionRuntime,
  conversationId: ConversationId,
  run: RunSnapshot,
  callerConversationId?: ConversationId,
): Omit<InspectedRunRenderItem, "subagentId" | "agent" | "label" | "status"> {
  const status = effectiveStatus(run.status);
  let config: Pick<ConversationSnapshot, "requestedOverrides" | "effectiveConfig"> & {
    parentSubagentId?: ConversationId;
    depth?: number;
  } = {};
  try {
    const conversation = runtime.conversation(conversationId);
    config = {
      ...(conversation.parentConversationId ? { parentSubagentId: conversation.parentConversationId } : {}),
      ...(conversation.requestedOverrides ? { requestedOverrides: conversation.requestedOverrides } : {}),
      ...(conversation.effectiveConfig ? { effectiveConfig: conversation.effectiveConfig } : {}),
      depth: runtime.conversationDepth(conversationId, callerConversationId),
    };
  } catch {}
  return {
    ...config,
    ...(status === "running" ? { phase: run.activity.phase } : {}),
    elapsedMs: runElapsedMs(run, Date.now()),
    turns: run.activity.turns,
    compactions: run.activity.compactions,
    ...(status === "running" && run.activity.messageSnippet
      ? { messageSnippet: truncateText(run.activity.messageSnippet, 500) }
      : {}),
    ...(run.status.kind === "done" && run.status.error
      ? { errorSnippet: truncateText(run.status.error, 500) }
      : {}),
    recentTools: run.activity.toolHistory.slice(-3).reverse().map(tool => ({
      toolCallId: tool.id,
      tool: tool.name,
      ...(tool.inputSummary ? { summary: truncateText(tool.inputSummary, 160) } : {}),
      status: tool.completedAt === undefined
        ? run.status.kind === "done" ? "interrupted" : "running"
        : tool.isError ? "error" : "completed",
    })),
    steers: (run.steers ?? []).slice(-5),
  };
}

type JoinedOutput = {
  subagentId: ConversationId;
  runId: RunId;
  status: RunStatus;
  output?: string;
  error?: string;
};
type JoinOutputError = { subagentId: string; agent?: string; label?: string; error: string; code?: string };
type JoinOutput = JoinedOutput | JoinOutputError;

function projectJoinResults(
  output: readonly JoinOutput[],
  deps: ActionDeps,
): Array<ItemResult<CanonicalLiveSubagent & { output?: string }, { subagentId: string } & ResultIdentity>> {
  return output.map(value => {
    if ("status" in value) {
      return {
        ...canonicalSubagent(deps, value.subagentId),
        ...(value.output !== undefined ? { output: value.output } : {}),
      };
    }
    return { ...targetFailure(deps, value.subagentId, value.error), ...(value.code ? { code: value.code } : {}) };
  });
}

function renderJoinedRuns(
  output: readonly JoinOutput[],
  runtime: ActionRuntime,
  final: boolean,
): JoinedRunRenderItem[] {
  const conversations = runtime.listConversations();
  const byRun = new Map(conversations.flatMap(conversation => conversation.runs.map(run =>
    [run.runId, { conversation, run }] as const)));
  const snapshot = (runId: RunId): RunSnapshot | undefined => {
    try { return runtime.runSnapshot(runId); } catch { return byRun.get(runId)?.run; }
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
  const status = (run: RunSnapshot): SubagentStatus => projectSubagentStatus(run.status);
  const activity = (run: RunSnapshot) => run.activity.toolHistory.map(tool => ({
    toolCallId: tool.id, tool: tool.name, ...(tool.inputSummary ? { summary: tool.inputSummary } : {}),
  }));
  const background = (ownerRunId: RunId, ownerLabel?: string) => {
    let children: readonly { runId: RunId; conversationId: ConversationId }[] = [];
    try { children = runtime.unjoinedDirectChildren(ownerRunId); } catch { return []; }
    if (!children.length) return [];
    return [{ ...(ownerLabel ? { ownerLabel } : {}), entries: children.map(child => {
      const childRun = snapshot(child.runId);
      const childStatus = childRun ? status(childRun) : "running";
      return { subagentId: child.conversationId, ...display(child.conversationId), status: childStatus,
        ...(final && (childStatus === "queued" || childStatus === "running") ? { detachedAtFinal: true } : {}) };
    }) }];
  };
  const target = (value: NestedJoinAttemptSnapshot["targets"][number]): JoinTargetRenderItem => {
    const run = snapshot(value.runId);
    const targetStatus = run ? status(run) : nestedTargetStatus(value.status);
    const base: JoinTargetRenderItem = { ...(value.conversationId ? { subagentId: value.conversationId, ...display(value.conversationId) } : {}), status: targetStatus };
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
    status: attempt.state === "running" ? "running" : attempt.state === "completed" ? "completed" : "failed",
    targets: attempt.targets.map(target), ...(attempt.error ? { error: attempt.error } : {}), ...(attempt.toolCallId ? { toolCallId: attempt.toolCallId } : {}),
  }));
  return output.map(value => {
    if (!("status" in value)) return { ...value, status: "failed" };
    const run = snapshot(value.runId);
    const projected = { subagentId: value.subagentId, status: run ? status(run) : joinedOutputStatus(value.status), ...(value.output !== undefined ? { output: value.output } : {}), ...(value.error !== undefined ? { error: value.error } : {}) };
    if (!run) return projected;
    const info = display(value.subagentId);
    const represented = (run.nestedJoins ?? []).flatMap(attempt => attempt.toolCallId ? [attempt.toolCallId] : []);
    return { ...projected, ...info, kind: run.kind, prompt: run.prompt, ...runStats(run), activity: activity(run), joins: joins(run),
      background: background(run.runId, info.label ?? info.agent), joinToolCallIds: represented };
  }) as JoinedRunRenderItem[];
}

function joinedOutputStatus(status: RunStatus): SubagentStatus {
  if (status === "queued" || status === "running" || status === "completed") return status;
  return status === "aborted" ? "cancelled" : "failed";
}

function nestedTargetStatus(status: NestedJoinAttemptSnapshot["targets"][number]["status"]): SubagentStatus {
  return status ? joinedOutputStatus(status) : "failed";
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
      "Delegate work asynchronously through persistent, context-isolated subagents. Subagents share the working filesystem.",
      "Actions:",
      "  agents(): List available agent definitions.",
      "  list(statuses?, joined?): List direct child subagents with descendant context.",
      "  spawn(spawns): Start labelled subagents.",
      "  resume(resumes): Continue existing subagents after joining their latest results.",
      "  steer(messages): Send messages to running subagents.",
      "  inspect(subagentIds): Check status and progress without waiting.",
      "  join(subagentIds): Wait for and collect a subagent's result; blocks while running, idempotent after.",
      "  cancel(subagentIds): Cancel active subagents; context and results are retained.",
      "  remove(subagentIds): Discard inactive subagent subtrees.",
    ].join("\n"),
    promptSnippet: "Delegate bounded work to context-isolated subagents",
    promptGuidelines: [
      "Delegate bounded, self-contained work to subagent; skip it when delegating costs more than doing, or when verifying the result means redoing the work.",
      "Write each subagent prompt as if to a stranger who shares only your filesystem: every input, path, and constraint, plus what to report or produce.",
      "Run subagents in parallel only when they're independent and touch disjoint files; join once you depend on a result or have nothing else to do.",
      "Inspect or steer a subagent only with cause: inspect when progress could change your next step, steer to add constraints or correct divergence.",
      "Resume a subagent after joining its latest outcome when its accumulated context helps the follow-up; spawn fresh when it would be irrelevant or misleading.",
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
      const settings = await prepareInvocation(ctx);
      const invocation = parseSubagentInvocation(params, { maxTasks: settings.runtime.maxTasksPerRun });
      if ("error" in invocation) return invocationErrorResult(actionDeps, invocation);

      switch (invocation.action) {
        case "agents": return agentsAction(actionDeps, invocation);
        case "list": return listAction(actionDeps, invocation);
        case "spawn": return spawnAction(actionDeps, invocation, ctx);
        case "resume": return resumeAction(actionDeps, invocation, ctx);
        case "steer": return steerAction(actionDeps, invocation);
        case "cancel": return cancelAction(actionDeps, invocation);
        case "inspect": return inspectAction(actionDeps, invocation);
        case "join": return joinAction(actionDeps, invocation, signal, onUpdate, toolCallId);
        case "remove": return removeAction(actionDeps, invocation);
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
