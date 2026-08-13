import { randomUUID } from "node:crypto";
import type { ContextEvent, Theme } from "@earendil-works/pi-coding-agent";
import { generationKey, parseGenerationKey, type Conversation, type ConversationSnapshot, type GenerationRef, type GenerationSnapshot } from "./conversation.js";
import type { ConversationUpdateKind } from "./conversation.js";
import { isFinishedSubagent, type CanonicalFinishedSubagent, type CanonicalLiveSubagent } from "./contract.js";
import type { SubagentRuntime } from "./runtime.js";
import type { SubagentStatus } from "./schema.js";
import { formatElapsed, generationElapsedMs, statusColor, truncateText } from "./generation-format.js";
import { DEFAULT_SUBAGENT_SETTINGS, type CompletionNotifyMode, type SubagentDisplaySettings } from "./settings.js";

type SerializableFinishedSubagent<T extends CanonicalFinishedSubagent = CanonicalFinishedSubagent> =
  T extends CanonicalFinishedSubagent ? Omit<T, "subagentId"> & { readonly subagentId: string } : never;

/** The current serializable completion summary shared by notification production and rendering. */
export type CompletionNotification = SerializableFinishedSubagent & {
  /** Exact one-based execution generation within the stable subagent conversation. */
  readonly generation: number;
  readonly completedAt: number;
  readonly elapsedMs: number;
};

interface CompletionCandidate {
  conversation: ConversationSnapshot;
  generation: GenerationSnapshot;
}

export interface CompletionNotificationMessageDetails {
  /** Process-local epoch correlation only; never rendered or accepted by lifecycle actions. */
  notificationEpoch?: string;
  completions: CompletionNotification[];
}

export interface CompletionNotificationMessage {
  content: string;
  details: CompletionNotificationMessageDetails;
}

type SerializableLiveSubagent<T extends CanonicalLiveSubagent = CanonicalLiveSubagent> =
  T extends CanonicalLiveSubagent ? Omit<T, "subagentId"> & { readonly subagentId: string } : never;
type UserActivityNotification = SerializableLiveSubagent & { readonly initiatedBy: "user" };
interface UserActivityMessageDetails {
  notificationEpoch?: string;
  activities: UserActivityNotification[];
}

const COMPLETION_GRACE_MS = 500;
const RESULTS_INSTRUCTION = "Use `subagent join` when you need to collect these results.";

type AgentMessage = ContextEvent["messages"][number];
type CustomMessage = Extract<AgentMessage, { role: "custom" }>;

/**
 * Creates the complete custom message sent for a batch of generation completions.
 *
 * The notification text and details are projected from the same copied entries so the producer
 * and renderer cannot drift on the payload shape. The renderer intentionally applies its own
 * collapsed/expanded presentation to preserve the existing themed surfaces.
 */
export function createCompletionNotificationMessage(
  entries: readonly CompletionNotification[],
  notificationEpoch?: string,
): CompletionNotificationMessage {
  const completions = entries.map(copyCompletionNotification);
  return {
    content: formatNotificationContent(completions),
    details: { ...(notificationEpoch ? { notificationEpoch } : {}), completions },
  };
}

function createUserActivityMessage(
  entries: readonly UserActivityNotification[],
  notificationEpoch?: string,
): { content: string; details: UserActivityMessageDetails } {
  const activities = entries.map(entry => ({ ...entry, actionHints: [...entry.actionHints] }));
  return {
    content: formatActivityContent(activities),
    details: { ...(notificationEpoch ? { notificationEpoch } : {}), activities },
  };
}

export function formatCompletionNotificationMessage(
  details: CompletionNotificationMessageDetails,
  expanded: boolean,
  theme: Pick<Theme, "fg"> | undefined,
  display: SubagentDisplaySettings = DEFAULT_SUBAGENT_SETTINGS.display,
): string {
  const completions = details.completions;
  const header = formatCompletionHeader(completions.length);
  const lines = completions.map(entry => formatCompletionEntry(entry, {
    display,
    expanded,
    theme,
  }));
  if (expanded) {
    lines.push("");
    lines.push(RESULTS_INSTRUCTION);
  }
  return [header, ...lines].join("\n");
}

function formatActivityContent(entries: readonly UserActivityNotification[]): string {
  const lines = entries.map(entry => `  <subagent subagentId="${escapeXml(entry.subagentId)}" generation="${entry.generation}" initiatedBy="user" status="${escapeXml(entry.status)}" agent="${escapeXml(entry.agent)}" label="${escapeXml(entry.label)}" collected="${entry.collected}"/>`);
  return [
    "<subagent-activity>",
    "  User-initiated shared-workspace activity. Awareness only; do not join or act unless relevant to the current request.",
    ...lines,
    "</subagent-activity>",
  ].join("\n");
}

function formatNotificationContent(entries: readonly CompletionNotification[]): string {
  const lines = entries.map(entry => {
    const attributes = [
      `subagentId="${escapeXml(entry.subagentId)}"`,
      `generation="${entry.generation}"`,
      `initiatedBy="${entry.initiatedBy}"`,
      `status="${escapeXml(entry.status)}"`,
      `agent="${escapeXml(entry.agent)}"`,
      `label="${escapeXml(entry.label)}"`,
      `collected="${entry.collected}"`,
      `actionHints="${escapeXml(entry.actionHints.join(","))}"`,
      ...(entry.failure ? [`failure="${escapeXml(entry.failure)}"`] : []),
    ];
    return `  <subagent ${attributes.join(" ")}/>`;
  });
  return ["<subagent-notification>", ...lines, "</subagent-notification>"].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function copyCompletionNotification<T extends CompletionNotification>(entry: T): T {
  return { ...entry, actionHints: [...entry.actionHints] };
}

function formatCompletionHeader(count: number): string {
  return `${count} subagent${count === 1 ? "" : "s"} finished:`;
}

interface CompletionEntryFormatOptions {
  display: SubagentDisplaySettings;
  expanded: boolean;
  theme?: Pick<Theme, "fg">;
}

function formatCompletionEntry(entry: CompletionNotification, options: CompletionEntryFormatOptions): string {
  const labelPart = entry.label !== undefined
    ? ` (${truncateText(entry.label, options.display.toolCallLabelMaxLength, true)})`
    : "";
  const status = colorCompletionStatus(entry.status, options.theme);
  const identityPart = options.expanded
    ? ` · subagentId ${entry.subagentId}`
    : "";
  return `- ${entry.agent}${labelPart} · ${status} · ${formatElapsed(entry.elapsedMs)}${identityPart}`;
}

function colorCompletionStatus(status: SubagentStatus, theme: Pick<Theme, "fg"> | undefined): string {
  return typeof theme?.fg === "function" ? theme.fg(statusColor(status), status) : status;
}

export interface NotifierContext {
  isIdle(): boolean;
  hasUI?: boolean;
  ui?: { notify?(message: string, level?: "info" | "warning" | "error"): void };
}
type Handler = (event: unknown, ctx?: NotifierContext) => void;
export interface CompletionNotifierPi {
  on?(event: "agent_end" | "turn_end" | "tool_execution_start" | "tool_execution_end" | "session_start" | "session_shutdown", handler: Handler): void;
  sendMessage?(message: { customType: string; content: string; display?: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void | Promise<void>;
}
export interface CompletionNotifierDeps {
  pi: CompletionNotifierPi;
  manager: SubagentRuntime;
  getMode: () => CompletionNotifyMode;
  scheduleRetry?: (fn: () => void, delayMs: number) => () => void;
}
interface ModelNotificationDelivery {
  completion: Promise<void>;
}
const schedule = (fn: () => void, ms: number) => { const handle = setTimeout(fn, ms); return () => clearTimeout(handle); };

/** Delivers UI completions, subscribed model completions, and next-turn user activity notices. */
export class CompletionNotifier {
  private ctx?: NotifierContext;
  private cancelTimer?: () => void;
  private cancelGraceTimer?: () => void;
  private retryToolOpportunity = false;
  private readonly modelNotified = new Set<string>();
  private readonly uiNotified = new Set<string>();
  private readonly activityNotified = new Set<string>();
  private readonly terminalAcknowledgedByModel = new Set<string>();
  private readonly gracePending = new Set<string>();
  private readonly claimsByInvocation = new Map<string, { action: unknown; generationKeys: Set<string> }>();
  private readonly claimCountByGeneration = new Map<string, number>();
  private readonly notificationEpoch = randomUUID();
  private readonly unsubscribeAgent: () => void;

  constructor(private readonly deps: CompletionNotifierDeps) {
    this.unsubscribeAgent = deps.manager.onConversationUpdate?.(this.onUpdate) ?? (() => {});
    deps.pi.on?.("session_start", (_e, ctx) => { this.ctx = ctx; this.arm(0); });
    deps.pi.on?.("session_shutdown", () => { this.ctx = undefined; this.cancel(); this.cancelGrace(); this.clearClaims(); });
    deps.pi.on?.("agent_end", (_e, ctx) => this.opportunity(ctx));
    deps.pi.on?.("turn_end", (_e, ctx) => this.opportunity(ctx));
    deps.pi.on?.("tool_execution_start", (event, ctx) => this.onToolStart(event, ctx));
    deps.pi.on?.("tool_execution_end", event => this.onToolEnd(event));
  }
  unsubscribe(): void { this.unsubscribeAgent(); this.cancel(); this.cancelGrace(); this.clearClaims(); }

  reconcileMessages(messages: readonly AgentMessage[]): AgentMessage[] {
    const seenActivities = new Set<string>();
    return messages.flatMap(message => {
      if (message.role !== "custom") return [message];
      if (message.customType === "subagent-completion") {
        const details = completionDetails(message);
        if (!details) return [message];
        if (details.notificationEpoch !== this.notificationEpoch) return [];
        const visible = details.completions.flatMap(entry => {
          const current = Number.isSafeInteger(entry.generation) ? this.currentNotificationEntry(entry.subagentId, entry.generation) : undefined;
          return current ? [current] : [];
        });
        if (!visible.length) return [];
        return [{ ...message, content: formatNotificationContent(visible), details: { notificationEpoch: this.notificationEpoch, completions: visible } } as AgentMessage];
      }
      if (message.customType !== "subagent-activity") return [message];
      const details = activityDetails(message);
      if (!details) return [message];
      if (details.notificationEpoch !== this.notificationEpoch) return [];
      const visible = details.activities.flatMap(entry => {
        const key = notificationKey(entry);
        if (seenActivities.has(key)) return [];
        const current = this.currentUserActivityEntry(entry.subagentId, entry.generation);
        if (!current) return [];
        seenActivities.add(key);
        return [current];
      });
      if (!visible.length) return [];
      return [{ ...message, content: formatActivityContent(visible), details: { notificationEpoch: this.notificationEpoch, activities: visible } } as AgentMessage];
    });
  }

  private currentNotificationEntry(subagentId: string, generation: number): CompletionNotification | undefined {
    const value = this.catalog().find(candidate =>
      candidate.conversation.conversationId === subagentId
      && candidate.generation.generation === generation);
    if (!value) return;
    const key = candidateKey(value);
    if (this.terminalAcknowledgedByModel.has(key) || this.claimCountByGeneration.has(key)) return;
    if (value.generation.receipts.model || value.generation.activeCollectionCount > 0 || !this.deps.manager.isModelSubscribed({ conversationId: value.conversation.conversationId, generation: value.generation.generation })) return;
    const projected = projectCompletionNotification(this.deps.manager, value);
    return projected;
  }

  private currentUserActivityEntry(subagentId: string, generation: number): UserActivityNotification | undefined {
    try {
      const conversation = this.deps.manager.conversation(subagentId);
      const current = conversation.generations.at(-1);
      if (!current || current.generation !== generation || current.initiatedBy !== "user") return;
      const reference = { conversationId: conversation.conversationId, generation };
      if (this.deps.manager.isModelSubscribed(reference)) return;
      return projectUserActivity(this.deps.manager, conversation, current);
    } catch { return; }
  }

  beginTool(scope: string, toolCallId: string, params: unknown): void {
    const target = claimTarget(params);
    const generationKeys = new Set([...target.subagentIds].flatMap(subagentId => {
      const generationKeyValue = this.currentGenerationKey(subagentId);
      return generationKeyValue ? [generationKeyValue] : [];
    }));
    if (!generationKeys.size) return;
    const key = `${scope}:${toolCallId}`;
    this.releaseToolClaim(key);
    for (const keyValue of generationKeys) this.claimCountByGeneration.set(keyValue, (this.claimCountByGeneration.get(keyValue) ?? 0) + 1);
    this.claimsByInvocation.set(key, { action: target.action, generationKeys });
  }

  completeTool(scope: string, toolCallId: string, result?: unknown): void {
    const key = `${scope}:${toolCallId}`;
    const claim = this.claimsByInvocation.get(key);
    if (!claim) return;
    const claimedConversationIds = new Set([...claim.generationKeys].map(generationConversationId));
    for (const reference of terminalAcknowledgedGenerationRefs(claim.action, result)) {
      if (!claimedConversationIds.has(reference.conversationId)) continue;
      try {
        if (this.deps.manager.generationSnapshot(reference).status.kind === "done") {
          this.terminalAcknowledgedByModel.add(generationKey(reference));
        }
      } catch {}
    }
    for (const keyValue of claim.generationKeys) {
      try {
        if (this.deps.manager.generationSnapshot(parseGenerationKey(keyValue)).receipts.model) this.modelNotified.add(keyValue);
      } catch {}
    }
    this.releaseToolClaim(key);
    this.arm(0);
  }

  handleToolEvent(scope: string, event: unknown): void {
    const type = event && typeof event === "object" ? (event as { type?: unknown }).type : undefined;
    if (type === "tool_execution_start") {
      const call = toolEvent(event);
      if (call?.toolName === "subagent") this.beginTool(scope, call.toolCallId, call.args);
    } else if (type === "tool_execution_end") {
      const call = toolEndEvent(event);
      if (call?.toolName === "subagent") this.completeTool(scope, call.toolCallId, call.result);
    }
  }

  private onUpdate = (agent: Conversation, kind: ConversationUpdateKind): void => {
    if (kind === "status") {
      const generation = agent.snapshot().generations.at(-1);
      if (generation?.status.kind === "done" && !this.modelNotified.has(generationKey({ conversationId: agent.conversationId, generation: generation.generation })) && !this.terminalAcknowledgedByModel.has(generationKey({ conversationId: agent.conversationId, generation: generation.generation }))) {
        this.gracePending.add(generationKey({ conversationId: agent.conversationId, generation: generation.generation }));
        this.armGrace();
      }
    }
    // A short grace window lets inspect, cancel, or join claim a generation before completion delivery.
    if (kind === "status" || kind === "collection" || kind === "activeCollection" || kind === "removed") this.arm(0);
  };
  private opportunity(ctx?: NotifierContext): void { if (ctx) this.ctx = ctx; this.flush(); }
  private onToolStart(event: unknown, ctx?: NotifierContext): void {
    if (ctx) this.ctx = ctx;
    const call = toolEvent(event);
    if (call?.toolName === "subagent") this.beginTool("root", call.toolCallId, call.args);
    const claimed = call?.toolName === "subagent" && claimTarget(call.args).subagentIds.size > 0;
    // Defer delivery until synchronous tool preflight finishes so later joins can claim generations.
    // list is deliberately not a delivery opportunity; a join starts by claiming.
    if (!claimed && toolAction(event) !== "list") this.arm(0, true);
  }
  private onToolEnd(event: unknown): void {
    const call = toolEndEvent(event);
    if (call?.toolName === "subagent") this.completeTool("root", call.toolCallId, call.result);
  }
  private arm(delay: number, toolOpportunity = false): void {
    this.retryToolOpportunity ||= toolOpportunity;
    if (this.cancelTimer) return;
    const scheduler = this.deps.scheduleRetry ?? schedule;
    this.cancelTimer = scheduler(() => {
      this.cancelTimer = undefined;
      const opportunity = this.retryToolOpportunity;
      this.retryToolOpportunity = false;
      this.flush(opportunity);
    }, delay);
  }
  private cancel(): void { this.cancelTimer?.(); this.cancelTimer = undefined; this.retryToolOpportunity = false; }
  private armGrace(): void {
    if (this.cancelGraceTimer) return;
    const scheduler = this.deps.scheduleRetry ?? schedule;
    this.cancelGraceTimer = scheduler(() => {
      this.cancelGraceTimer = undefined;
      this.gracePending.clear();
      this.arm(0);
    }, COMPLETION_GRACE_MS);
  }
  private cancelGrace(): void { this.cancelGraceTimer?.(); this.cancelGraceTimer = undefined; }
  private releaseToolClaim(key: string): void {
    const claim = this.claimsByInvocation.get(key);
    if (!claim) return;
    this.claimsByInvocation.delete(key);
    for (const keyValue of claim.generationKeys) {
      const remaining = (this.claimCountByGeneration.get(keyValue) ?? 1) - 1;
      if (remaining > 0) this.claimCountByGeneration.set(keyValue, remaining);
      else this.claimCountByGeneration.delete(keyValue);
    }
  }
  private clearClaims(): void {
    for (const key of [...this.claimsByInvocation.keys()]) this.releaseToolClaim(key);
  }

  private flush(toolOpportunity = false): void {
    const mode = this.deps.getMode();
    if (!this.ctx) return;
    if (mode === "none") {
      this.cancel();
      this.flushUserActivity();
      return;
    }
    this.flushUserActivity();

    const eligible = this.catalog().filter(candidate => {
      const keyValue = candidateKey(candidate);
      return !this.gracePending.has(keyValue)
        && !this.claimCountByGeneration.has(keyValue)
        && candidate.generation.activeCollectionCount === 0;
    });
    if (!eligible.length) return;

    const projected = eligible.flatMap(candidate => {
      const entry = projectCompletionNotification(this.deps.manager, candidate);
      return entry ? [{ candidate, entry }] : [];
    });
    this.notifyUi(projected
      .filter(({ candidate }) => !candidate.generation.receipts.user)
      .map(({ entry }) => entry));

    const modelEntries = projected.flatMap(({ candidate, entry }) => {
      const keyValue = candidateKey(candidate);
      const reference = notificationRef(entry);
      return !candidate.generation.receipts.model
        && !this.terminalAcknowledgedByModel.has(keyValue)
        && !this.modelNotified.has(keyValue)
        && this.deps.manager.isModelSubscribed(reference)
        ? [entry]
        : [];
    });
    if (!modelEntries.length) return;
    if (mode === "auto" && !this.ctx.isIdle()) { this.arm(500); return; }
    if (mode === "steer" && !toolOpportunity && !this.ctx.isIdle()) return;

    const active = !this.ctx.isIdle();
    const delivery = this.notifyModel(modelEntries, mode === "steer" && active
      ? { deliverAs: "steer" }
      : { triggerTurn: true });
    if (!delivery) {
      if (this.deps.pi.sendMessage) this.arm(500, mode === "steer" && active);
      return;
    }

    for (const entry of modelEntries) this.modelNotified.add(notificationKey(entry));
    void delivery.completion.catch(() => {
      for (const entry of modelEntries) this.modelNotified.delete(notificationKey(entry));
      this.arm(500, mode === "steer" && active);
    });
  }
  private flushUserActivity(): void {
    const entries = this.deps.manager.listConversations().flatMap(conversation => {
      const generation = conversation.generations.at(-1);
      if (!generation || generation.initiatedBy !== "user") return [];
      const reference = { conversationId: conversation.conversationId, generation: generation.generation };
      const stageKey = activityStageKey(reference, generation.status.kind === "done" ? "finished" : "active");
      if (this.activityNotified.has(stageKey) || this.deps.manager.isModelSubscribed(reference)) return [];
      const projected = projectUserActivity(this.deps.manager, conversation, generation);
      return projected ? [{ entry: projected, stageKey }] : [];
    });
    if (!entries.length || !this.deps.pi.sendMessage) return;
    const message = createUserActivityMessage(entries.map(value => value.entry), this.notificationEpoch);
    try {
      const sent = this.deps.pi.sendMessage({ customType: "subagent-activity", display: false, ...message }, { deliverAs: "nextTurn" });
      for (const value of entries) this.activityNotified.add(value.stageKey);
      void Promise.resolve(sent).catch(() => {
        for (const value of entries) this.activityNotified.delete(value.stageKey);
        this.arm(500);
      });
    } catch {
      this.arm(500);
    }
  }
  private notifyModel(
    entries: readonly CompletionNotification[],
    options: { triggerTurn: true } | { deliverAs: "steer" },
  ): ModelNotificationDelivery | undefined {
    if (!this.deps.pi.sendMessage) return;
    const message = createCompletionNotificationMessage(entries, this.notificationEpoch);
    try {
      return {
        completion: Promise.resolve(this.deps.pi.sendMessage({
          customType: "subagent-completion",
          display: false,
          ...message,
        }, options)),
      };
    } catch {
      return;
    }
  }
  private notifyUi(entries: readonly CompletionNotification[]): void {
    if (!this.ctx?.hasUI || !this.ctx.ui?.notify) return;
    const pending = entries.filter(entry => !this.uiNotified.has(notificationKey(entry)));
    if (!pending.length) return;
    try {
      this.ctx.ui.notify(formatUiNotification(pending), completionNotificationLevel(pending));
      for (const entry of pending) this.uiNotified.add(notificationKey(entry));
    } catch {}
  }

  private currentGenerationKey(subagentId: string): string | undefined {
    try {
      const snapshot = this.deps.manager.conversation(subagentId);
      const generation = snapshot.generations.at(-1);
      return generation ? generationKey({ conversationId: snapshot.conversationId, generation: generation.generation }) : undefined;
    } catch { return; }
  }

  private catalog(): CompletionCandidate[] {
    return this.deps.manager.listConversations().flatMap(conversation => {
      const generation = conversation.generations.at(-1);
      return generation?.status.kind === "done" ? [{ conversation, generation }] : [];
    });
  }
}

function generationConversationId(key: string): string {
  return parseGenerationKey(key).conversationId;
}

function candidateKey(candidate: CompletionCandidate): string {
  return generationKey({
    conversationId: candidate.conversation.conversationId,
    generation: candidate.generation.generation,
  });
}

function notificationRef(notification: Pick<CompletionNotification, "subagentId" | "generation">): GenerationRef {
  return {
    conversationId: notification.subagentId as GenerationRef["conversationId"],
    generation: notification.generation,
  };
}
function notificationKey(notification: Pick<CompletionNotification, "subagentId" | "generation">): string {
  return generationKey(notificationRef(notification));
}
function activityStageKey(reference: GenerationRef, stage: "active" | "finished"): string {
  return `${generationKey(reference)}:${stage}`;
}

function projectUserActivity(
  manager: SubagentRuntime,
  conversation: ConversationSnapshot,
  generation: GenerationSnapshot,
): UserActivityNotification | undefined {
  if (generation.initiatedBy !== "user" || conversation.generations.at(-1)?.generation !== generation.generation) return;
  const canonical = manager.projectSubagent(conversation.conversationId, undefined, { maxLength: 500 });
  return canonical.initiatedBy === "user" ? { ...canonical, initiatedBy: "user" } : undefined;
}

function projectCompletionNotification(manager: SubagentRuntime, value: CompletionCandidate): CompletionNotification | undefined {
  if (value.generation.status.kind !== "done") return;
  const canonical = manager.projectSubagent(value.conversation.conversationId, undefined, { maxLength: 500 });
  if (!isFinishedSubagent(canonical)) return;
  return {
    ...canonical,
    generation: value.generation.generation,
    completedAt: value.generation.status.completedAt,
    elapsedMs: generationElapsedMs(value.generation),
  };
}

function formatUiNotification(entries: readonly CompletionNotification[]): string {
  const summary = entries.map(entry => `${entry.agent}${entry.label ? ` (${entry.label})` : ""} · ${entry.status}`).join(", ");
  return `${formatCompletionHeader(entries.length)} ${summary}`;
}

function completionNotificationLevel(entries: readonly CompletionNotification[]): "info" | "warning" | "error" {
  if (entries.some(entry => entry.status === "failed")) return "error";
  if (entries.some(entry => entry.status === "cancelled")) return "warning";
  return "info";
}

function activityDetails(message: CustomMessage): UserActivityMessageDetails | undefined {
  const details = message.details;
  if (!details || typeof details !== "object") return;
  const notificationEpoch = (details as { notificationEpoch?: unknown }).notificationEpoch;
  const activities = (details as { activities?: unknown }).activities;
  if (notificationEpoch !== undefined && typeof notificationEpoch !== "string") return;
  if (!Array.isArray(activities)) return;
  const valid = activities.filter(isUserActivityNotification);
  return { ...(notificationEpoch ? { notificationEpoch } : {}), activities: valid };
}

function completionDetails(message: CustomMessage): CompletionNotificationMessageDetails | undefined {
  const details = message.details;
  if (!details || typeof details !== "object") return;
  const notificationEpoch = (details as { notificationEpoch?: unknown }).notificationEpoch;
  const completions = (details as { completions?: unknown }).completions;
  if (notificationEpoch !== undefined && typeof notificationEpoch !== "string") return;
  if (!Array.isArray(completions)) return;
  const valid = completions.filter(isCompletionNotification);
  return { ...(notificationEpoch ? { notificationEpoch } : {}), completions: valid };
}

function isUserActivityNotification(entry: unknown): entry is UserActivityNotification {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as Record<string, unknown>;
  return value.ok === true
    && typeof value.subagentId === "string"
    && typeof value.label === "string"
    && typeof value.agent === "string"
    && Number.isSafeInteger(value.generation)
    && (value.generation as number) >= 1
    && value.initiatedBy === "user"
    && (value.status === "queued" || value.status === "running" || value.status === "completed" || value.status === "failed" || value.status === "cancelled")
    && typeof value.collected === "boolean"
    && Array.isArray(value.actionHints);
}

function isCompletionNotification(entry: unknown): entry is CompletionNotification {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as Record<string, unknown>;
  if (
    value.ok !== true
    || (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1)
    || typeof value.subagentId !== "string"
    || typeof value.label !== "string"
    || typeof value.agent !== "string"
    || (value.initiatedBy !== "user" && value.initiatedBy !== "model")
    || typeof value.collected !== "boolean"
    || !Array.isArray(value.actionHints)
    || typeof value.completedAt !== "number"
    || typeof value.elapsedMs !== "number"
  ) return false;
  if (value.status === "failed") return typeof value.failure === "string";
  return (value.status === "completed" || value.status === "cancelled") && value.failure === undefined;
}

function toolAction(event: unknown): unknown {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { toolName?: unknown; args?: { action?: unknown } };
  return value.toolName === "subagent" ? value.args?.action : undefined;
}
function claimTarget(params: unknown): { action: unknown; subagentIds: Set<string> } {
  if (!params || typeof params !== "object") return { action: undefined, subagentIds: new Set() };
  const value = params as { action?: unknown; subagentIds?: unknown };
  const action = value.action;
  if ((action !== "inspect" && action !== "cancel" && action !== "join") || !Array.isArray(value.subagentIds)) return { action, subagentIds: new Set() };
  return { action, subagentIds: new Set(value.subagentIds.filter((id): id is string => typeof id === "string")) };
}
function toolEvent(event: unknown): { toolCallId: string; toolName: unknown; args: unknown } | undefined {
  if (!event || typeof event !== "object") return;
  const value = event as { toolCallId?: unknown; toolName?: unknown; args?: unknown };
  if (typeof value.toolCallId !== "string") return;
  return { toolCallId: value.toolCallId, toolName: value.toolName, args: value.args };
}
function toolEndEvent(event: unknown): { toolCallId: string; toolName: unknown; result: unknown } | undefined {
  if (!event || typeof event !== "object") return;
  const value = event as { toolCallId?: unknown; toolName?: unknown; result?: unknown };
  if (typeof value.toolCallId !== "string") return;
  return { toolCallId: value.toolCallId, toolName: value.toolName, result: value.result };
}
function terminalAcknowledgedGenerationRefs(action: unknown, result: unknown): GenerationRef[] {
  if ((action !== "inspect" && action !== "cancel") || !result || typeof result !== "object") return [];
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return [];
  const response = (details as { response?: unknown }).response;
  if (!response || typeof response !== "object" || (response as { action?: unknown }).action !== action) return [];
  const observedGenerations = (details as { observedGenerations?: unknown }).observedGenerations;
  if (!Array.isArray(observedGenerations) || !observedGenerations.every(isGenerationRef)) return [];
  return observedGenerations;
}

function isGenerationRef(value: unknown): value is GenerationRef {
  if (!value || typeof value !== "object") return false;
  const reference = value as { conversationId?: unknown; generation?: unknown };
  return typeof reference.conversationId === "string"
    && Number.isSafeInteger(reference.generation)
    && (reference.generation as number) >= 1;
}
