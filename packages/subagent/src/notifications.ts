import { randomUUID } from "node:crypto";
import type { ContextEvent, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Conversation, ConversationSnapshot, RunSnapshot } from "./conversation.js";
import type { RunOutcomeStatus, ConversationUpdateKind } from "./conversation.js";
import type { SubagentRuntime } from "./runtime.js";
import { RUN_OUTCOME_STATUSES } from "./schema.js";
import type { RunId } from "./identifiers.js";
import { formatElapsed, runElapsedMs } from "./run-format.js";
import { DEFAULT_SUBAGENT_SETTINGS, type CompletionNotifyMode, type SubagentDisplaySettings } from "./settings.js";

/** The current serializable completion summary shared by notification production and rendering. */
export interface CompletionNotification {
  subagentId: string;
  agent: string;
  label?: string;
  status: RunOutcomeStatus;
  generation: number;
  completedAt: number;
  elapsedMs: number;
}

interface TrackedCompletionNotification extends CompletionNotification {
  runId: string;
}

interface CompletionCandidate {
  conversation: ConversationSnapshot;
  run: RunSnapshot;
  generation: number;
}

export interface CompletionNotificationMessageDetails {
  /** Runtime-local correlation only; never rendered or accepted by lifecycle actions. */
  notificationEpoch?: string;
  completions: CompletionNotification[];
}

export interface CompletionNotificationMessage {
  content: string;
  details: CompletionNotificationMessageDetails;
}

export type CompletionNotificationMessagePayload = CompletionNotificationMessage;

const COMPLETION_GRACE_MS = 500;
const TERMINAL_RUN_STATUSES = new Set<unknown>(RUN_OUTCOME_STATUSES);
const RESULTS_INSTRUCTION = "Use `subagent join` when you need these terminal outcomes.";

type AgentMessage = ContextEvent["messages"][number];
type CustomMessage = Extract<AgentMessage, { role: "custom" }>;

/**
 * Creates the complete custom message sent for a batch of run completions.
 *
 * The notification text and details are projected from the same copied entries so the producer
 * and renderer cannot drift on the payload shape. The renderer intentionally applies its own
 * collapsed/expanded presentation to preserve the existing themed surfaces.
 */
export function createCompletionNotificationMessage(
  entries: readonly CompletionNotification[],
  notificationEpoch?: string,
): CompletionNotificationMessagePayload {
  const completions = entries.map(copyCompletionNotification);
  return {
    content: formatNotificationContent(completions),
    details: { ...(notificationEpoch ? { notificationEpoch } : {}), completions },
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

function formatNotificationContent(entries: readonly CompletionNotification[]): string {
  const lines = entries.map(entry => {
    const attributes = [
      `subagentId="${escapeXml(entry.subagentId)}"`,
      `status="${escapeXml(entry.status)}"`,
      `agent="${escapeXml(entry.agent)}"`,
      ...(entry.label !== undefined ? [`label="${escapeXml(entry.label)}"`] : []),
    ];
    return `  <run ${attributes.join(" ")}/>`;
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

function copyCompletionNotification(entry: CompletionNotification): CompletionNotification {
  return {
    subagentId: entry.subagentId,
    agent: entry.agent,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    status: entry.status,
    generation: entry.generation,
    completedAt: entry.completedAt,
    elapsedMs: entry.elapsedMs,
  };
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
    ? ` (${compactRendererLabel(entry.label, options.display.toolCallLabelMaxLength)})`
    : "";
  const status = colorCompletionStatus(entry.status, options.theme);
  const identityPart = options.expanded
    ? ` · subagentId ${entry.subagentId}`
    : "";
  return `- ${entry.agent}${labelPart} · ${status} · ${formatElapsed(entry.elapsedMs)}${identityPart}`;
}

function compactRendererLabel(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function colorCompletionStatus(status: RunOutcomeStatus, theme: Pick<Theme, "fg"> | undefined): string {
  const color = statusColor(status);
  return typeof theme?.fg === "function" ? theme.fg(color, status) : status;
}

/** Uses the completion renderer palette for every current terminal status. */
function statusColor(status: RunOutcomeStatus): ThemeColor {
  if (status === "completed") return "success";
  if (status === "error") return "error";
  if (status === "aborted" || status === "interrupted") return "warning";
  return "dim";
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
const schedule = (fn: () => void, ms: number) => { const handle = setTimeout(fn, ms); return () => clearTimeout(handle); };

/** Delivers batched notifications for terminal runs the parent has not observed or acknowledged. */
export class CompletionNotifier {
  private ctx?: NotifierContext;
  private cancelTimer?: () => void;
  private cancelGraceTimer?: () => void;
  private retryToolOpportunity = false;
  private readonly delivered = new Set<string>();
  private readonly uiNotified = new Set<string>();
  private readonly observed = new Set<string>();
  private readonly gracePending = new Set<string>();
  private readonly claimsByToolCall = new Map<string, { action: unknown; runIds: Set<string> }>();
  private readonly claimCountByRun = new Map<string, number>();
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
    return messages.flatMap(message => {
      if (message.role !== "custom" || message.customType !== "subagent-completion") return [message];
      const details = completionDetails(message);
      if (!details) return [message];
      if (details.notificationEpoch !== this.notificationEpoch) return [];
      const visible = details.completions.flatMap(entry => {
        const current = this.currentNotificationEntry(entry.subagentId, entry.generation);
        return current ? [current] : [];
      });
      if (!visible.length) return [];
      return [{ ...message, content: formatNotificationContent(visible), details: { notificationEpoch: this.notificationEpoch, completions: visible } }];
    });
  }

  private currentNotificationEntry(subagentId: string, generation: number): CompletionNotification | undefined {
    const value = this.catalog().find(candidate =>
      candidate.conversation.conversationId === subagentId && candidate.generation === generation);
    if (!value || this.observed.has(value.run.runId) || this.claimCountByRun.has(value.run.runId)) return;
    if (value.run.acknowledged || value.run.observerCount > 0) return;
    return projectCompletionNotification(value);
  }

  beginTool(scope: string, toolCallId: string, params: unknown): void {
    const target = claimTarget(params);
    const runIds = new Set([...target.subagentIds].flatMap(subagentId => {
      const runId = this.latestRunId(subagentId);
      return runId ? [runId] : [];
    }));
    if (!runIds.size) return;
    const key = `${scope}:${toolCallId}`;
    this.releaseToolClaim(key);
    for (const runId of runIds) this.claimCountByRun.set(runId, (this.claimCountByRun.get(runId) ?? 0) + 1);
    this.claimsByToolCall.set(key, { action: target.action, runIds });
  }

  completeTool(scope: string, toolCallId: string, result?: unknown): void {
    const key = `${scope}:${toolCallId}`;
    const claim = this.claimsByToolCall.get(key);
    if (!claim) return;
    for (const subagentId of observedTerminalSubagentIds(claim.action, result)) {
      const runId = this.latestRunId(subagentId);
      if (runId && claim.runIds.has(runId)) this.observed.add(runId);
    }
    for (const id of claim.runIds) {
      try {
        if (this.deps.manager.runSnapshot(id as RunId).acknowledged) this.delivered.add(id);
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
      const run = agent.snapshot().runs.at(-1);
      if (run?.status.kind === "done" && !this.delivered.has(run.runId) && !this.observed.has(run.runId)) {
        this.gracePending.add(run.runId);
        this.armGrace();
      }
    }
    // A short grace window lets inspect, cancel, or join claim a run before completion delivery.
    if (kind === "status" || kind === "observer" || kind === "acknowledgement" || kind === "removed") this.arm(0);
  };
  private opportunity(ctx?: NotifierContext): void { if (ctx) this.ctx = ctx; this.flush(); }
  private onToolStart(event: unknown, ctx?: NotifierContext): void {
    if (ctx) this.ctx = ctx;
    const call = toolEvent(event);
    if (call?.toolName === "subagent") this.beginTool("root", call.toolCallId, call.args);
    const claimed = call?.toolName === "subagent" && claimTarget(call.args).subagentIds.size > 0;
    // Defer delivery until synchronous tool preflight finishes so later joins can claim runs.
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
    const claim = this.claimsByToolCall.get(key);
    if (!claim) return;
    this.claimsByToolCall.delete(key);
    for (const runId of claim.runIds) {
      const remaining = (this.claimCountByRun.get(runId) ?? 1) - 1;
      if (remaining > 0) this.claimCountByRun.set(runId, remaining);
      else this.claimCountByRun.delete(runId);
    }
  }
  private clearClaims(): void {
    for (const key of [...this.claimsByToolCall.keys()]) this.releaseToolClaim(key);
  }

  private flush(toolOpportunity = false): void {
    const mode = this.deps.getMode();
    if (mode === "none") { this.cancel(); return; }
    const eligible = this.catalog().filter(({ run }) => !this.delivered.has(run.runId) && !this.observed.has(run.runId) && !this.gracePending.has(run.runId) && !this.claimCountByRun.has(run.runId) && !run.acknowledged && run.observerCount === 0);
    if (!eligible.length) return;
    if (!this.ctx) return;
    if (mode === "auto" && !this.ctx.isIdle()) { this.arm(500); return; }
    if (mode === "steer" && !toolOpportunity && !this.ctx.isIdle()) return;

    // Catalog, observer and acknowledgement state are intentionally projected again immediately before send.
    const live = new Map(this.catalog().map(value => [value.run.runId, value]));
    const entries: TrackedCompletionNotification[] = [];
    for (const candidate of eligible) {
      const value = live.get(candidate.run.runId);
      if (!value || value.run.acknowledged || value.run.observerCount || this.claimCountByRun.has(value.run.runId)) continue;
      const projected = projectCompletionNotification(value);
      if (projected) entries.push({ runId: value.run.runId, ...projected });
    }
    if (!entries.length || !this.deps.pi.sendMessage) return;
    const message = createCompletionNotificationMessage(entries, this.notificationEpoch);
    const active = !this.ctx.isIdle();
    try {
      const sent = this.deps.pi.sendMessage({ customType: "subagent-completion", display: false, ...message }, mode === "steer" && active ? { deliverAs: "steer" } : { triggerTurn: true });
      this.notifyUi(entries);
      for (const entry of entries) this.delivered.add(entry.runId);
      void Promise.resolve(sent).catch(() => {
        for (const entry of entries) this.delivered.delete(entry.runId);
        this.arm(500, mode === "steer" && active);
      });
    } catch {
      for (const entry of entries) this.delivered.delete(entry.runId);
      this.arm(500, mode === "steer" && active);
    }
  }
  private notifyUi(entries: readonly TrackedCompletionNotification[]): void {
    if (!this.ctx?.hasUI || !this.ctx.ui?.notify) return;
    const pending = entries.filter(entry => !this.uiNotified.has(entry.runId));
    if (!pending.length) return;
    try {
      this.ctx.ui.notify(formatUiNotification(pending), completionNotificationLevel(pending));
      for (const entry of pending) this.uiNotified.add(entry.runId);
    } catch {}
  }

  private latestRunId(subagentId: string): string | undefined {
    try { return this.deps.manager.conversation(subagentId).runs.at(-1)?.runId; } catch { return; }
  }

  private catalog(): CompletionCandidate[] {
    return this.deps.manager.listConversations().flatMap(conversation => conversation.runs
      .map((run, index) => ({ conversation, run, generation: index + 1 }))
      .filter(value => value.run.status.kind === "done"));
  }
}

function projectCompletionNotification(value: CompletionCandidate): CompletionNotification | undefined {
  if (value.run.status.kind !== "done") return;
  return {
    subagentId: value.conversation.conversationId,
    agent: value.conversation.config.name,
    ...(value.conversation.label ? { label: value.conversation.label } : {}),
    status: value.run.status.outcome,
    generation: value.generation,
    completedAt: value.run.status.completedAt,
    elapsedMs: runElapsedMs(value.run),
  };
}

function formatUiNotification(entries: readonly CompletionNotification[]): string {
  const summary = entries.map(entry => `${entry.agent}${entry.label ? ` (${entry.label})` : ""} · ${entry.status}`).join(", ");
  return `${formatCompletionHeader(entries.length)} ${summary}`;
}

function completionNotificationLevel(entries: readonly CompletionNotification[]): "info" | "warning" | "error" {
  if (entries.some(entry => entry.status === "error")) return "error";
  if (entries.some(entry => entry.status !== "completed")) return "warning";
  return "info";
}

function completionDetails(message: CustomMessage): CompletionNotificationMessageDetails | undefined {
  const details = message.details;
  if (!details || typeof details !== "object") return;
  const notificationEpoch = (details as { notificationEpoch?: unknown }).notificationEpoch;
  const completions = (details as { completions?: unknown }).completions;
  if (notificationEpoch !== undefined && typeof notificationEpoch !== "string") return;
  if (!Array.isArray(completions)) return;
  const valid = completions.filter((entry): entry is CompletionNotification => Boolean(
    entry && typeof entry === "object" &&
    typeof (entry as CompletionNotification).subagentId === "string" &&
    typeof (entry as CompletionNotification).agent === "string" &&
    typeof (entry as CompletionNotification).status === "string" &&
    typeof (entry as CompletionNotification).generation === "number" &&
    typeof (entry as CompletionNotification).completedAt === "number" &&
    typeof (entry as CompletionNotification).elapsedMs === "number",
  ));
  return { ...(notificationEpoch ? { notificationEpoch } : {}), completions: valid };
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
function observedTerminalSubagentIds(action: unknown, result: unknown): string[] {
  if ((action !== "inspect" && action !== "cancel") || !result || typeof result !== "object") return [];
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return [];
  const runs = (details as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap(value => {
    if (!value || typeof value !== "object" || "error" in value) return [];
    const run = value as { subagentId?: unknown; status?: unknown };
    if (typeof run.subagentId !== "string" || !TERMINAL_RUN_STATUSES.has(run.status)) return [];
    return [run.subagentId];
  });
}
