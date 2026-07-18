import { DEFAULT_SUBAGENT_SETTINGS, type CompletionNotifyMode, type SubagentDisplaySettings } from "../config/settings.js";
import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind } from "../domain/agent-lifecycle.js";
import type { AgentManager } from "./agent-manager.js";
import { createCompletionNotificationMessage, type CompletionNotification } from "../view/completion-message.js";

export interface NotifierContext { isIdle(): boolean }
type Handler = (event: unknown, ctx?: NotifierContext) => void;
export interface CompletionNotifierPi {
  on?(event: "agent_end" | "turn_end" | "tool_execution_start" | "session_start" | "session_shutdown", handler: Handler): void;
  sendMessage?(message: { customType: string; content: string; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void | Promise<void>;
}
export interface CompletionNotifierDeps {
  pi: CompletionNotifierPi;
  manager: AgentManager;
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
    this.unsubscribeAgent = deps.manager.onAgentUpdate?.(this.onUpdate) ?? (() => {});
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

  private onUpdate = (_agent: Agent, kind: AgentUpdateKind): void => {
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
    // list is deliberately not a delivery opportunity; a join starts by claiming.
    if (ids.size === 0 && toolAction(event) !== "list") this.flush(true);
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
