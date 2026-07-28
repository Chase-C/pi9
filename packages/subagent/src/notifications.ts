import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Conversation } from "./conversation.js";
import type { RunOutcomeStatus, ConversationUpdateKind } from "./conversation.js";
import type { SubagentRuntime } from "./runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS, type CompletionNotifyMode, type SubagentDisplaySettings } from "./settings.js";

/** The current serializable completion summary shared by notification production and rendering. */
export interface CompletionNotification {
  runId: string;
  conversationId: string;
  agent: string;
  label?: string;
  status: RunOutcomeStatus;
  elapsedMs: number;
}

export interface CompletionNotificationMessageDetails {
  completions: CompletionNotification[];
}

export interface CompletionNotificationMessage {
  content: string;
  details: CompletionNotificationMessageDetails;
}

export type CompletionNotificationMessagePayload = CompletionNotificationMessage;

const MAX_LISTED_COMPLETIONS = 20;
const RESULTS_INSTRUCTION = "Call subagent join with these runIds to retrieve output.";

type EntrySurface = "notification" | "renderer";

/**
 * Creates the complete custom message sent for a batch of run completions.
 *
 * The notification text and details are projected from the same copied entries so the producer
 * and renderer cannot drift on the payload shape. The renderer intentionally applies its own
 * collapsed/expanded presentation to preserve the existing themed surfaces.
 */
export function createCompletionNotificationMessage(
  entries: readonly CompletionNotification[],
  display: SubagentDisplaySettings = DEFAULT_SUBAGENT_SETTINGS.display,
): CompletionNotificationMessagePayload {
  const completions = entries.map(copyCompletionNotification);
  return {
    content: formatNotificationContent(completions, display),
    details: { completions },
  };
}

export function formatCompletionNotificationMessage(
  details: CompletionNotificationMessageDetails,
  expanded: boolean,
  theme: Pick<Theme, "fg"> | undefined,
  display: SubagentDisplaySettings = DEFAULT_SUBAGENT_SETTINGS.display,
): string {
  const completions = details.completions;
  const header = formatCompletionHeader(completions.length, expanded);
  const lines = completions.map(entry => formatCompletionEntry(entry, {
    display,
    surface: "renderer",
    expanded,
    theme,
  }));
  if (expanded) {
    lines.push("");
    lines.push(RESULTS_INSTRUCTION);
  }
  return [header, ...lines].join("\n");
}

function formatNotificationContent(entries: readonly CompletionNotification[], display: SubagentDisplaySettings): string {
  const visible = entries.slice(0, MAX_LISTED_COMPLETIONS);
  const overflow = entries.length - visible.length;
  const header = formatCompletionHeader(entries.length, true);
  const lines = visible.map(entry => formatCompletionEntry(entry, {
    display,
    surface: "notification",
    expanded: true,
  }));
  if (overflow > 0) lines.push(`- ... and ${overflow} more`);
  lines.push("");
  lines.push(RESULTS_INSTRUCTION);
  return [header, ...lines].join("\n");
}

function copyCompletionNotification(entry: CompletionNotification): CompletionNotification {
  return {
    runId: entry.runId,
    conversationId: entry.conversationId,
    agent: entry.agent,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    status: entry.status,
    elapsedMs: entry.elapsedMs,
  };
}

function formatCompletionHeader(count: number, includeSinceLastNotification: boolean): string {
  return `${count} subagent${count === 1 ? "" : "s"} completed${includeSinceLastNotification ? " since the last notification:" : ""}`;
}

interface CompletionEntryFormatOptions {
  display: SubagentDisplaySettings;
  surface: EntrySurface;
  expanded: boolean;
  theme?: Pick<Theme, "fg">;
}

function formatCompletionEntry(entry: CompletionNotification, options: CompletionEntryFormatOptions): string {
  const labelPart = entry.label !== undefined
    ? ` (${formatCompletionLabel(entry.label, options.display.toolCallLabelMaxLength, options.surface)})`
    : "";
  const status = options.surface === "renderer"
    ? colorCompletionStatus(entry.status, options.theme)
    : entry.status;
  const identityPart = options.expanded
    ? ` · runId ${entry.runId} · conversationId ${entry.conversationId}`
    : "";
  return `- ${entry.agent}${labelPart} · ${status} · ${formatElapsed(entry.elapsedMs)}${identityPart}`;
}

/** Keeps producer and renderer truncation rules distinct while giving them one semantic owner. */
function formatCompletionLabel(value: string, limit: number, surface: EntrySurface): string {
  if (surface === "notification") return truncateNotificationLabel(value, limit);
  return compactRendererLabel(value, limit);
}

function truncateNotificationLabel(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
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

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.floor(seconds - minutes * 60);
  return `${minutes}m${remSeconds.toString().padStart(2, "0")}s`;
}

export interface NotifierContext { isIdle(): boolean }
type Handler = (event: unknown, ctx?: NotifierContext) => void;
export interface CompletionNotifierPi {
  on?(event: "agent_end" | "turn_end" | "tool_execution_start" | "session_start" | "session_shutdown", handler: Handler): void;
  sendMessage?(message: { customType: string; content: string; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void | Promise<void>;
}
export interface CompletionNotifierDeps {
  pi: CompletionNotifierPi;
  manager: SubagentRuntime;
  getMode: () => CompletionNotifyMode;
  getDisplay?: () => SubagentDisplaySettings;
  scheduleRetry?: (fn: () => void, delayMs: number) => () => void;
}
const schedule = (fn: () => void, ms: number) => { const handle = setTimeout(fn, ms); return () => clearTimeout(handle); };

/** Delivers one notification for each unacknowledged terminal run, not each conversation. */
export class CompletionNotifier {
  private ctx?: NotifierContext;
  private cancelTimer?: () => void;
  private retryToolOpportunity = false;
  private readonly delivered = new Set<string>();
  private readonly claimed = new Map<string, () => void>();
  private readonly unsubscribeAgent: () => void;

  constructor(private readonly deps: CompletionNotifierDeps) {
    this.unsubscribeAgent = deps.manager.onConversationUpdate?.(this.onUpdate) ?? (() => {});
    deps.pi.on?.("session_start", (_e, ctx) => { this.ctx = ctx; this.arm(0); });
    deps.pi.on?.("session_shutdown", () => { this.ctx = undefined; this.cancel(); this.clearClaims(); });
    deps.pi.on?.("agent_end", (_e, ctx) => this.opportunity(ctx));
    deps.pi.on?.("turn_end", (_e, ctx) => this.opportunity(ctx));
    deps.pi.on?.("tool_execution_start", (event, ctx) => this.onToolStart(event, ctx));
  }
  unsubscribe(): void { this.unsubscribeAgent(); this.cancel(); this.clearClaims(); }

  /** Completes the claim begun by tool_execution_start, including rejected or cancelled joins. */
  releaseJoinClaims(runIds: readonly string[]): void {
    for (const id of runIds) this.releaseClaim(id);
    this.arm(0);
  }

  private onUpdate = (_agent: Conversation, kind: ConversationUpdateKind): void => {
    if (kind === "observer") {
      const active = new Map<string, number>(this.catalog().map(value => [value.run.runId, value.run.observerCount]));
      for (const [id] of this.claimed) if (active.get(id) === 0) this.releaseClaim(id);
    }
    // A grace turn lets a join tool start claim a run before completion delivery.
    if (kind === "status" || kind === "observer" || kind === "acknowledgement") this.arm(0);
  };
  private opportunity(ctx?: NotifierContext): void { if (ctx) this.ctx = ctx; this.flush(); }
  private onToolStart(event: unknown, ctx?: NotifierContext): void {
    if (ctx) this.ctx = ctx;
    const ids = joinRunIds(event);
    for (const id of ids) this.claim(id);
    // Defer delivery until synchronous tool preflight finishes so later joins can claim runs.
    // list is deliberately not a delivery opportunity; a join starts by claiming.
    if (ids.size === 0 && toolAction(event) !== "list") this.arm(0, true);
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
  private claim(id: string): void {
    this.releaseClaim(id);
    const scheduler = this.deps.scheduleRetry ?? schedule;
    // Tool preparation can involve async settings and registry I/O. The tool completion hook is
    // the normal release path; this is only protection against a missing host completion.
    const cancel = scheduler(() => { if (this.claimed.get(id) !== cancel) return; this.claimed.delete(id); this.arm(0); }, 300_000);
    this.claimed.set(id, cancel);
  }
  private releaseClaim(id: string): void { this.claimed.get(id)?.(); this.claimed.delete(id); }
  private clearClaims(): void { for (const cancel of this.claimed.values()) cancel(); this.claimed.clear(); }

  private flush(toolOpportunity = false): void {
    const mode = this.deps.getMode();
    if (mode === "none") { this.cancel(); return; }
    const eligible = this.catalog().filter(({ run }) => !this.delivered.has(run.runId) && !this.claimed.has(run.runId) && !run.acknowledged && run.observerCount === 0);
    if (!eligible.length) return;
    if (!this.ctx) return;
    if (mode === "auto" && !this.ctx.isIdle()) { this.arm(500); return; }
    if (mode === "steer" && !toolOpportunity && !this.ctx.isIdle()) return;

    // Catalog, observer and acknowledgement state are intentionally projected again immediately before send.
    const live = new Map(this.catalog().map(value => [value.run.runId, value]));
    const entries: CompletionNotification[] = [];
    for (const candidate of eligible) {
      const value = live.get(candidate.run.runId);
      if (!value || value.run.acknowledged || value.run.observerCount || this.claimed.has(value.run.runId)) continue;
      const started = value.run.status.kind === "done" ? value.run.status.startedAt ?? value.run.createdAt : value.run.createdAt;
      if (value.run.status.kind !== "done") continue;
      entries.push({ runId: value.run.runId, conversationId: value.conversation.conversationId, agent: value.conversation.config.name, ...(value.conversation.label ? { label: value.conversation.label } : {}), status: value.run.status.outcome, elapsedMs: Math.max(0, value.run.status.completedAt - started) });
    }
    if (!entries.length || !this.deps.pi.sendMessage) return;
    const message = createCompletionNotificationMessage(entries, this.deps.getDisplay?.() ?? DEFAULT_SUBAGENT_SETTINGS.display);
    const active = !this.ctx.isIdle();
    try {
      const sent = this.deps.pi.sendMessage({ customType: "subagent-completion", ...message }, mode === "steer" && active ? { deliverAs: "steer" } : { triggerTurn: true });
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
  private catalog() {
    return this.deps.manager.listConversations().flatMap(conversation => conversation.runs
      .filter(run => run.status.kind === "done")
      .map(run => ({ conversation, run })));
  }
}
function toolAction(event: unknown): unknown {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { toolName?: unknown; args?: { action?: unknown } };
  return value.toolName === "subagent" ? value.args?.action : undefined;
}
function joinRunIds(event: unknown): Set<string> {
  if (!event || typeof event !== "object") return new Set();
  const value = event as { toolName?: unknown; args?: { action?: unknown; runIds?: unknown } };
  if (value.toolName !== "subagent" || value.args?.action !== "join" || !Array.isArray(value.args.runIds)) return new Set();
  return new Set(value.args.runIds.filter((id): id is string => typeof id === "string"));
}
