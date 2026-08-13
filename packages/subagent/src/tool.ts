import { defineTool, type AgentToolUpdateCallback, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { effectiveStatus, type Conversation, type ConversationSnapshot, type GenerationRef, type GenerationSnapshot, type GenerationViewStatus, type NestedJoinAttemptSnapshot } from "./conversation.js";
import { projectSubagentGenerationStatus, projectSubagentStatus, type CanonicalLiveSubagent, type FailureProjectionMode } from "./contract.js";
import { listAgentDefinitions, type AgentRegistry } from "./agents.js";
import type { ConversationId, SubagentId } from "./identifiers.js";
import { generationElapsedMs, truncateText } from "./generation-format.js";
import type { JoinBinding, NestedJoinBinding, OrderedStartOutcome, SubagentCaller, SubagentRuntime } from "./runtime.js";
import type { GenerationScheduler } from "./scheduler.js";
import { parseSubagentInvocation, SubagentParams, type TaskRequest, type SteerRequest, type SubagentAction, type SubagentInvocation, type SubagentInvocationParseError, type SubagentStatus } from "./schema.js";
import type { SubagentSettings } from "./settings.js";
import type { SubagentErrorEnvelope, SubagentResultsEnvelope } from "./tool-contract.js";
import {
  renderSubagentCall,
  renderSubagentResult,
  type JoinedGenerationRenderItem,
  type JoinInvocationRenderItem,
  type JoinTargetRenderItem,
  type DispatchTaskRenderItem,
  type DispatchRenderView,
  type InspectedGenerationRenderItem,
  type JoinRenderView,
  type GenerationMetricsRenderItem,
  type SubagentToolDetails,
} from "./tool-renderer.js";

export type ActionRuntime = Pick<SubagentRuntime,
  | "queryConversations"
  | "conversationDepth"
  | "listConversations"
  | "startTasks"
  | "steerSubagent"
  | "cancelSubagent"
  | "inspectSubagents"
  | "validateSubagentJoin"
  | "bindSubagentJoin"
  | "onConversationUpdate"
  | "removeConversations"
  | "conversation"
  | "conversationDisplay"
  | "projectSubagent"
  | "subagentStatus"
  | "generationSnapshot"
  | "uncollectedDirectChildGenerations"
> & { scheduler: Pick<GenerationScheduler, "suspendConversationSlotDuring"> };

export interface ActionDeps {
  runtime: ActionRuntime;
  agentRegistry: AgentRegistry;
  parent?: Conversation;
  caller?: SubagentCaller;
}

export interface ActionResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentToolDetails;
  isError?: boolean;
}

type InvocationFor<A extends SubagentAction> = Extract<SubagentInvocation, { action: A }>;
type OrderedDispatchOutcome = OrderedStartOutcome;
function callerOf(deps: ActionDeps): SubagentCaller | undefined {
  return deps.caller ?? (deps.parent
    ? { conversation: deps.parent, generation: deps.parent.requireCurrentGeneration() }
    : undefined);
}

type DescendantSummary = {
  readonly subagentId: ConversationId;
  readonly label: string;
  readonly agent: string;
  readonly status: CanonicalLiveSubagent["status"];
  readonly descendants?: DescendantSummary[];
};

interface ActionFailure {
  readonly ok: false;
  readonly error: string;
}

type UnresolvedTargetFailure = ActionFailure & { readonly subagentId: string };
type LiveTargetFailure<T extends CanonicalLiveSubagent = CanonicalLiveSubagent> =
  T extends CanonicalLiveSubagent ? ActionFailure & Omit<T, "ok"> : never;
type TargetFailure = UnresolvedTargetFailure | LiveTargetFailure;

function actionFailure(error: unknown): Omit<ActionFailure, "ok"> {
  return { error: error instanceof Error ? error.message : String(error) };
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
): TargetFailure {
  const failure = actionFailure(error);
  try {
    const caller = callerOf(deps);
    deps.runtime.validateSubagentJoin(subagentId as SubagentId, caller);
    const live = deps.runtime.projectSubagent(subagentId, caller, { maxLength: 500 });
    return { ...live, ok: false, error: failure.error };
  } catch {
    return { ok: false, subagentId, error: failure.error };
  }
}

const BATCH_ACTIONS = new Set<SubagentAction>(["spawn", "resume", "steer", "cancel", "inspect", "join", "remove"]);

function resultsEnvelope<A extends SubagentAction, T>(action: A, results: readonly T[]): SubagentResultsEnvelope<A, T> {
  if (!BATCH_ACTIONS.has(action)) return { action, results };
  const succeeded = results.filter(result => (
    typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true
  )).length;
  return {
    action,
    summary: { requested: results.length, succeeded, failed: results.length - succeeded },
    results,
  };
}

function resultsResult<A extends SubagentAction, T>(
  action: A,
  results: readonly T[],
  view?: DispatchRenderView | JoinRenderView,
  pretty = true,
  internal?: { readonly observedGenerations: readonly GenerationRef[] },
): ActionResult {
  const response = resultsEnvelope(action, results);
  return {
    content: [{ type: "text", text: JSON.stringify(response, null, pretty ? 2 : undefined) }],
    details: { response, ...(view ? { view } : {}), ...internal } as SubagentToolDetails,
  };
}

export function errorResult(message: string, requestedAction?: SubagentAction): ActionResult {
  const envelope: SubagentErrorEnvelope = {
    action: requestedAction ?? "unknown",
    error: message,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    details: { response: envelope },
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
  return resultsResult("agents", agents.map(agent => ({ ok: true as const, ...agent })));
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
        agent: item.agent.name,
        status: deps.runtime.subagentStatus(item.conversationId),
        ...(children.length ? { descendants: children } : {}),
      };
    });
  const conversations = deps.runtime.queryConversations(callerConversationId)
    .map(conversation => ({
      ...canonicalSubagent(deps, conversation.conversationId, { maxLength: 500 }),
      descendants: descendants(conversation.conversationId),
    }))
    .filter(conversation => !invocation.statuses || invocation.statuses.includes(conversation.status))
    .filter(conversation => invocation.collected === undefined || conversation.collected === invocation.collected);
  return resultsResult("list", conversations);
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
  const validTasks: TaskRequest[] = [];
  const validIndexes: number[] = [];

  for (let inputIndex = 0; inputIndex < tasks.length; inputIndex++) {
    const task = tasks[inputIndex];
    if ("error" in task) outcomes.push({ ok: false, inputIndex, error: task.error });
    else { validTasks.push(task); validIndexes.push(inputIndex); }
  }
  if (validTasks.length) {
    const handle = deps.runtime.startTasks(ctx, validTasks, owner ? { caller: owner } : {});
    for (const start of handle.starts) outcomes.push({ ...start, inputIndex: validIndexes[start.inputIndex] });
  }
  outcomes.sort((left, right) => left.inputIndex - right.inputIndex);

  const conversations = deps.runtime.listConversations();
  const receipts = outcomes.map(outcome => projectGenerationReceipt(deps, tasks[outcome.inputIndex], outcome));
  return resultsResult(action, receipts, {
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
        ? targetFailure(deps, target, outcome.error)
        : { ok: false as const, error: outcome.error };
  });
  return resultsResult("steer", results, {
    tasks: renderDispatchItems(invocation.messages, outcomes, deps.runtime.listConversations()),
  });
}

export async function cancelAction(
  deps: ActionDeps,
  invocation: InvocationFor<"cancel">,
): Promise<ActionResult> {
  const owner = callerOf(deps);
  const outcomes = await Promise.all(invocation.subagentIds.map(async target => {
    if (typeof target !== "string") return { entry: { ok: false as const, subagentId: target.subagentId, error: target.error } };
    let result: Awaited<ReturnType<ActionRuntime["cancelSubagent"]>>;
    try {
      result = await deps.runtime.cancelSubagent(target as SubagentId, owner);
    } catch (error) {
      return { entry: targetFailure(deps, target, error) };
    }
    const observed = { conversationId: result.conversationId, generation: result.generation };
    try {
      return {
        entry: canonicalSubagent(deps, result.conversationId),
        observed,
      };
    } catch (error) {
      return { entry: targetFailure(deps, target, error), observed };
    }
  }));

  return resultsResult(
    "cancel",
    outcomes.map(outcome => outcome.entry),
    undefined,
    true,
    { observedGenerations: outcomes.flatMap(outcome => outcome.observed ? [outcome.observed] : []) },
  );
}

export function inspectAction(
  deps: ActionDeps,
  invocation: InvocationFor<"inspect">,
): ActionResult {
  const owner = callerOf(deps);
  const outcomes = invocation.subagentIds.map(target => {
    if (typeof target !== "string") return { entry: { ok: false as const, subagentId: target.subagentId, error: target.error } };
    let inspected: ReturnType<ActionRuntime["inspectSubagents"]>[number];
    try {
      inspected = deps.runtime.inspectSubagents([target as SubagentId], owner)[0];
    } catch (error) {
      return { entry: targetFailure(deps, target, error) };
    }
    const observed = inspected.snapshot.status.kind === "done"
      ? { conversationId: inspected.conversationId, generation: inspected.snapshot.generation }
      : undefined;
    try {
      const diagnostics = projectInspection(deps.runtime, inspected.conversationId, inspected.snapshot, owner?.conversation.conversationId);
      return {
        entry: { ...canonicalSubagent(deps, inspected.conversationId, { maxLength: 500 }), ...diagnostics },
        ...(observed ? { observed } : {}),
      };
    } catch (error) {
      return { entry: targetFailure(deps, target, error), ...(observed ? { observed } : {}) };
    }
  });
  return resultsResult(
    "inspect",
    outcomes.map(outcome => outcome.entry),
    undefined,
    true,
    { observedGenerations: outcomes.flatMap(outcome => "observed" in outcome && outcome.observed ? [outcome.observed] : []) },
  );
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
    if (typeof target !== "string") return { ok: false as const, ...target };
    try {
      deps.runtime.validateSubagentJoin(target as SubagentId, owner);
      return target;
    } catch (error) {
      return { ok: false as const, subagentId: target, ...actionFailure(error) };
    }
  });
  const validSubagentIds = targets.filter((target): target is SubagentId => typeof target === "string");

  if (validSubagentIds.length === 0) {
    const result = targets as JoinOutput[];
    return resultsResult("join", projectJoinResults(result, deps), { entries: renderJoinedGenerations(result, deps.runtime, true) });
  }

  let binding: JoinBinding | NestedJoinBinding;
  try {
    binding = deps.runtime.bindSubagentJoin(validSubagentIds, owner, toolCallId);
  } catch (error) {
    const failures = targets.map(target => typeof target === "string"
      ? targetFailure(deps, target, error)
      : targetFailure(deps, target.subagentId, target.error));
    return resultsResult("join", failures, { entries: renderJoinedGenerations(failures, deps.runtime, true) });
  }

  let bindingReleased = false;
  const releaseBinding = () => {
    if (bindingReleased) return;
    bindingReleased = true;
    binding.release();
  };
  const output = (entries = binding.project()): JoinOutput[] => {
    let entryIndex = 0;
    return targets.map(target => typeof target === "string"
      ? projectJoinedEntry(entries[entryIndex++])
      : target);
  };
  const currentResult = (final = false, pretty = true, collectionOutput = output()): ActionResult => {
    return resultsResult("join", projectJoinResults(collectionOutput, deps), {
      entries: renderJoinedGenerations(collectionOutput, deps.runtime, final),
    }, pretty);
  };
  const emit = () => onUpdate?.(currentResult(false, false));
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
      ? deps.runtime.scheduler.suspendConversationSlotDuring(deps.parent, wait)
      : wait());
    unsubscribe();
    const finalized = binding.finalizeCollection("model");
    bindingReleased = true;
    return currentResult(true, true, output(finalized));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (owner) (binding as NestedJoinBinding).interrupt(message);
    return errorResult(message, "join");
  } finally {
    unsubscribe();
    releaseBinding();
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function projectJoinedEntry(entry: ReturnType<JoinBinding["project"]>[number] | ReturnType<JoinBinding["finalizeCollection"]>[number]): JoinedOutput {
  return {
    ok: true,
    conversationId: entry.conversationId,
    generation: entry.generation,
    status: entry.status,
    ...(entry.status.kind === "done" ? { output: entry.status.output ?? null } : {}),
    ...(entry.status.kind === "done" && entry.status.error !== undefined ? { error: entry.status.error } : {}),
    ...("canonical" in entry ? { canonical: entry.canonical } : {}),
  };
}

export async function removeAction(
  deps: ActionDeps,
  invocation: InvocationFor<"remove">,
): Promise<ActionResult> {
  const validIds = invocation.subagentIds.filter((target): target is ConversationId => typeof target === "string");
  const removed = await deps.runtime.removeConversations(validIds, callerOf(deps));
  let outcomeIndex = 0;
  const results = invocation.subagentIds.map(target => {
    if (typeof target !== "string") return { ok: false as const, subagentId: target.subagentId, error: target.error };
    const outcome = removed[outcomeIndex++];
    return outcome.ok
      ? { ok: true as const, subagentId: target, label: outcome.label, removedIds: outcome.removedIds }
      : { ok: false as const, subagentId: target, error: outcome.error };
  });
  return resultsResult("remove", results);
}

function projectGenerationReceipt(
  deps: ActionDeps,
  task: TaskRequest | { error: string; agent?: string; label?: string; subagentId?: string } | undefined,
  outcome: OrderedDispatchOutcome,
) {
  if (outcome.ok) return canonicalSubagent(deps, outcome.conversationId);

  if (task && !("error" in task) && task.kind === "resume") {
    return targetFailure(deps, task.subagentId, outcome.error);
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
  return { ok: false, ...identity, error: outcome.error };
}

function renderDispatchItems(
  tasks: readonly (TaskRequest | SteerRequest | { error: string; label?: string })[],
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
      agent: task.kind === "spawn" ? task.agent : conversation?.agent.name,
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
  generation: GenerationSnapshot,
  callerConversationId?: ConversationId,
): Omit<InspectedGenerationRenderItem, "subagentId" | "agent" | "label" | "status"> {
  const status = effectiveStatus(generation.status);
  const now = Date.now();
  let generations: readonly GenerationSnapshot[] = [generation];
  let config: Pick<ConversationSnapshot, "requestedOverrides" | "effectiveConfig"> & {
    parentSubagentId?: ConversationId;
    depth?: number;
  } = {};
  try {
    const conversation = runtime.conversation(conversationId);
    generations = conversation.generations;
    config = {
      ...(conversation.parentConversationId ? { parentSubagentId: conversation.parentConversationId } : {}),
      ...(conversation.requestedOverrides ? { requestedOverrides: conversation.requestedOverrides } : {}),
      ...(conversation.effectiveConfig ? { effectiveConfig: conversation.effectiveConfig } : {}),
      depth: runtime.conversationDepth(conversationId, callerConversationId),
    };
  } catch {}
  const history = generations.slice(0, -1).map(historicalGeneration => ({
    generation: historicalGeneration.generation,
    kind: historicalGeneration.kind,
    initiatedBy: historicalGeneration.initiatedBy,
    status: projectSubagentStatus(historicalGeneration.status),
    collected: historicalGeneration.receipts.model,
    ...generationMetrics(historicalGeneration, now),
    steers: historicalGeneration.steers,
  }));
  const metrics = generationMetrics(generation, now);
  const totalMetrics = generations.reduce<GenerationMetricsRenderItem>((total, item) => {
    const itemMetrics = generationMetrics(item, now);
    return {
      elapsedMs: total.elapsedMs + itemMetrics.elapsedMs,
      turns: total.turns + itemMetrics.turns,
      compactions: total.compactions + itemMetrics.compactions,
      tokens: total.tokens + itemMetrics.tokens,
    };
  }, { elapsedMs: 0, turns: 0, compactions: 0, tokens: 0 });
  return {
    ...config,
    ...(status === "running" ? { phase: generation.activity.phase } : {}),
    generation: generation.generation,
    initiatedBy: generation.initiatedBy,
    metrics,
    totalMetrics,
    history,
    ...(status === "running" && generation.activity.messageSnippet
      ? { messageSnippet: truncateText(generation.activity.messageSnippet, 500) }
      : {}),
    ...(generation.status.kind === "done" && generation.status.error
      ? { errorSnippet: truncateText(generation.status.error, 500) }
      : {}),
    recentTools: generation.activity.toolHistory.slice(-3).reverse().map(tool => ({
      toolCallId: tool.id,
      tool: tool.name,
      ...(tool.inputSummary ? { summary: truncateText(tool.inputSummary, 160) } : {}),
      status: tool.completedAt === undefined
        ? generation.status.kind === "done" ? "interrupted" : "running"
        : tool.isError ? "error" : "completed",
    })),
    steers: generation.steers.slice(-5),
  };
}

function generationMetrics(generation: GenerationSnapshot, now: number): GenerationMetricsRenderItem {
  return {
    elapsedMs: generationElapsedMs(generation, now),
    turns: generation.activity.turns,
    compactions: generation.activity.compactions,
    tokens: generation.usage.totalTokens ?? 0,
  };
}

type JoinedOutput = GenerationRef & {
  readonly ok: true;
  readonly status: GenerationViewStatus;
  readonly output?: string | null;
  readonly error?: string;
  readonly canonical?: CanonicalLiveSubagent;
};
type JoinOutput = JoinedOutput | TargetFailure;

function projectJoinResults(
  output: readonly JoinOutput[],
  deps: ActionDeps,
) {
  return output.map(value => {
    if (value.ok) {
      return {
        ...(value.canonical ?? canonicalSubagent(deps, value.conversationId)),
        generation: value.generation,
        ...(value.output !== undefined ? { output: value.output } : {}),
      };
    }
    return targetFailure(deps, value.subagentId, value.error);
  });
}

function renderJoinedGenerations(
  output: readonly JoinOutput[],
  runtime: ActionRuntime,
  final: boolean,
): JoinedGenerationRenderItem[] {
  const conversations = runtime.listConversations();
  const snapshot = (reference: GenerationRef): GenerationSnapshot | undefined => {
    try { return runtime.generationSnapshot(reference); } catch { return undefined; }
  };
  const display = (conversationId: ConversationId | undefined) => {
    if (!conversationId) return {};
    const local = conversations.find(item => item.conversationId === conversationId);
    if (local) return { agent: local.agent.name, ...(local.label ? { label: local.label } : {}) };
    try {
      const value = runtime.conversationDisplay(conversationId);
      return { ...(value.agentName ? { agent: value.agentName } : {}), ...(value.label ? { label: value.label } : {}) };
    } catch { return {}; }
  };
  const status = (generation: GenerationSnapshot): SubagentStatus => projectSubagentStatus(generation.status);
  const activity = (generation: GenerationSnapshot) => generation.activity.toolHistory.map(tool => ({
    toolCallId: tool.id, tool: tool.name, ...(tool.inputSummary ? { summary: tool.inputSummary } : {}),
  }));
  const background = (owner: GenerationRef, ownerLabel?: string) => {
    let children: readonly GenerationRef[];
    try { children = runtime.uncollectedDirectChildGenerations(owner); } catch { return []; }
    if (!children.length) return [];
    return [{ ...(ownerLabel ? { ownerLabel } : {}), entries: children.map(child => {
      const childGeneration = snapshot(child);
      const childStatus = childGeneration ? status(childGeneration) : "running";
      return { subagentId: child.conversationId, ...display(child.conversationId), status: childStatus,
        ...(final && (childStatus === "queued" || childStatus === "running") ? { detachedAtFinal: true } : {}) };
    }) }];
  };
  const target = (value: NestedJoinAttemptSnapshot["targets"][number]): JoinTargetRenderItem => {
    const generation = snapshot(value);
    const targetStatus = generation ? status(generation) : value.status ? projectSubagentGenerationStatus(value.status) : "failed";
    const base: JoinTargetRenderItem = { subagentId: value.conversationId, ...display(value.conversationId), status: targetStatus };
    if (!generation) return base;
    return {
      ...base,
      ...generationStats(generation),
      activity: activity(generation),
      joins: joins(generation),
      background: background(value, base.label ?? base.agent),
      ...(generation.status.kind === "done" && generation.status.error ? { error: generation.status.error } : {}),
    };
  };
  const joins = (generation: GenerationSnapshot): JoinInvocationRenderItem[] => (generation.nestedJoins ?? []).map(attempt => ({
    status: attempt.state === "running" ? "running" : attempt.state === "completed" ? "completed" : "failed",
    targets: attempt.targets.map(target),
    ...(attempt.error ? { error: attempt.error } : {}),
    ...(attempt.toolCallId ? { toolCallId: attempt.toolCallId } : {}),
  }));
  return output.map(value => {
    if (!value.ok) {
      const { ok: _, ...failure } = value;
      return { ...failure, status: "failed" };
    }
    const generation = snapshot(value);
    const projected = {
      subagentId: value.conversationId,
      status: generation ? status(generation) : projectSubagentStatus(value.status),
      ...(typeof value.output === "string" ? { output: value.output } : {}),
      ...(value.error !== undefined ? { error: value.error } : {}),
    };
    if (!generation) return projected;
    const info = display(value.conversationId);
    const represented = (generation.nestedJoins ?? []).flatMap(attempt => attempt.toolCallId ? [attempt.toolCallId] : []);
    return {
      ...projected,
      ...info,
      kind: generation.kind,
      prompt: generation.prompt,
      ...generationStats(generation),
      activity: activity(generation),
      joins: joins(generation),
      background: background(value, info.label ?? info.agent),
      joinToolCallIds: represented,
    };
  }) as JoinedGenerationRenderItem[];
}

function generationStats(generation: GenerationSnapshot): Pick<JoinedGenerationRenderItem, "elapsedMs" | "turns" | "tokens"> {
  return {
    elapsedMs: generationElapsedMs(generation),
    turns: generation.activity.turns,
    tokens: generation.usage.totalTokens ?? 0,
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
  parent?: Conversation;
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
      "  list(statuses?, collected?): List child subagents with descendant summaries, optionally filtered by the model's collection receipt.",
      "  spawn(spawns): Start subagents; each spawn begins a generation.",
      "  resume(resumes): Start a subagent's next generation; requires the prior generation initiator's collection receipt.",
      "  steer(messages): Send messages to running subagents.",
      "  inspect(subagentIds): Check descendant status and progress without waiting.",
      "  join(subagentIds): Wait for completion and collect each result for the model; idempotent after collection.",
      "  cancel(subagentIds): Idempotently cancel generations; retain subagents, context, and results.",
      "  remove(subagentIds): Permanently discard inactive subagent subtrees, including uncollected results.",
    ].join("\n"),
    promptSnippet: "Delegate bounded work to context-isolated subagents",
    promptGuidelines: [
      "Delegate bounded, self-contained work to subagent; skip when delegation costs more than doing, or when verifying the result means redoing the work.",
      "Subagents see only their prompt and the filesystem; include every input, path, and constraint, plus what to report or produce.",
      "Parallelize subagents only when independent and writing disjoint files; otherwise run serially.",
      "While a subagent runs, intervene only with cause: inspect when progress could change your next step, steer to correct or constrain.",
      "Join a subagent when you depend on its result or are otherwise idle; join waits for completion and records the model's collection receipt.",
      "Resume a subagent only after the prior generation initiator has a collection receipt and when its accumulated context helps; spawn fresh when it would be irrelevant or misleading.",
    ],
    parameters: SubagentParams,
    renderCall(args, theme) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderSubagentResult(result, options, theme);
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const invocationDeps: ActionDeps = parent
        ? { ...actionDeps, caller: { conversation: parent, generation: parent.requireCurrentGeneration() } }
        : actionDeps;
      const settings = await prepareInvocation(ctx);
      const invocation = parseSubagentInvocation(params, { maxTasks: settings.runtime.maxTasksPerCall });
      if ("error" in invocation) return invocationErrorResult(invocationDeps, invocation);

      switch (invocation.action) {
        case "agents": return agentsAction(invocationDeps, invocation);
        case "list": return listAction(invocationDeps, invocation);
        case "spawn": return spawnAction(invocationDeps, invocation, ctx);
        case "resume": return resumeAction(invocationDeps, invocation, ctx);
        case "steer": return steerAction(invocationDeps, invocation);
        case "cancel": return cancelAction(invocationDeps, invocation);
        case "inspect": return inspectAction(invocationDeps, invocation);
        case "join": return joinAction(invocationDeps, invocation, signal, onUpdate, toolCallId);
        case "remove": return removeAction(invocationDeps, invocation);
      }
    },
  });
}

export interface ChildToolDeps {
  runtime: SubagentRuntime;
  agentRegistry: AgentRegistry;
  parent: Conversation;
  getCurrentSettings: () => SubagentSettings;
}

export function makeChildSubagentTool(deps: ChildToolDeps): ToolDefinition {
  const { runtime, agentRegistry, parent, getCurrentSettings } = deps;
  return defineSubagentTool({
    runtime,
    agentRegistry,
    prepareInvocation: async () => getCurrentSettings(),
    parent,
  });
}
