import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind, AgentRunStatus } from "../domain/agent-view.js";
import type { AgentUpdateListener } from "./agent-manager.js";
import type { BackgroundNotifyMode } from "../ui/settings.js";
import { getSubagentDisplaySettings } from "../view/view-helpers.js";

export interface NotifierManager {
  onAgentUpdate?(listener: AgentUpdateListener): () => void;
}

const MAX_LISTED_COMPLETIONS = 20;

export interface NotifierContext {
  isIdle(): boolean;
}

type PiEventHandler = (event: unknown, ctx?: NotifierContext) => void;

export interface NotifierPi {
  on(event: "agent_end", handler: PiEventHandler): void;
  on(event: "turn_end", handler: PiEventHandler): void;
  on(event: "tool_execution_start", handler: PiEventHandler): void;
  on(event: "session_start", handler: PiEventHandler): void;
  on(event: "session_shutdown", handler: PiEventHandler): void;
  sendMessage(
    message: { customType: string; content: string; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

export interface BackgroundNotifierDeps {
  pi: NotifierPi;
  manager: NotifierManager;
  getMode: () => BackgroundNotifyMode;
  /**
   * Schedule a delayed retry of the idle flush. Returns a cancel function.
   * Defaults to a setTimeout-based implementation.
   */
  scheduleRetry?: (fn: () => void, delayMs: number) => () => void;
  /** Delay between idle-flush retry attempts. Defaults to 500ms. */
  retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 500;

const defaultScheduleRetry = (fn: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(fn, delayMs);
  return () => clearTimeout(handle);
};

interface CompletionEntry {
  sessionId: string;
  agent: string;
  label?: string;
  status: AgentRunStatus;
  elapsedMs: number;
}

export class BackgroundNotifier {
  private _queue: CompletionEntry[] = [];
  private _notifiedTerminalSessionIds = new Set<string>();
  private _unsubAgent: () => void = () => {};
  private _disposed = false;
  private _ctx: NotifierContext | undefined;
  private _ctxGen = 0;
  private _retryCancel: (() => void) | undefined;
  private readonly _scheduleRetry: (fn: () => void, delayMs: number) => () => void;
  private readonly _retryDelayMs: number;

  constructor(private readonly deps: BackgroundNotifierDeps) {
    this._scheduleRetry = deps.scheduleRetry ?? defaultScheduleRetry;
    this._retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (typeof deps.manager.onAgentUpdate === "function") {
      this._unsubAgent = deps.manager.onAgentUpdate(this._handleAgentUpdate);
    }
    if (typeof deps.pi.on === "function") {
      deps.pi.on("session_start", ((_event: unknown, ctx?: NotifierContext) => this._onSessionStart(ctx)) as PiEventHandler);
      deps.pi.on("session_shutdown", (() => this._onSessionShutdown()) as PiEventHandler);
      deps.pi.on("agent_end", ((_event: unknown, ctx?: NotifierContext) => this._onDispatchEvent("auto", ctx)) as PiEventHandler);
      deps.pi.on("turn_end", ((_event: unknown, ctx?: NotifierContext) => this._onDispatchEvent("auto", ctx)) as PiEventHandler);
      deps.pi.on("tool_execution_start", ((_event: unknown, ctx?: NotifierContext) => this._onDispatchEvent("steer", ctx)) as PiEventHandler);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._unsubAgent();
    this._cancelRetry();
    this._ctx = undefined;
    this._queue = [];
    this._notifiedTerminalSessionIds.clear();
  }

  private _onSessionStart(ctx: NotifierContext | undefined): void {
    if (this._disposed) return;
    this._ctx = ctx;
    this._ctxGen++;
    this._cancelRetry();
    this._tryFlushForCurrentMode();
  }

  private _onSessionShutdown(): void {
    if (this._disposed) return;
    this._ctx = undefined;
    this._ctxGen++;
    this._cancelRetry();
  }

  private _handleAgentUpdate = (agent: Agent, kind: AgentUpdateKind): void => {
    if (this._disposed) return;
    if (kind !== "status") return;
    if (!agent.background) return;
    const status = agent.status;
    if (status.kind === "running" || status.kind === "queued") {
      this._notifiedTerminalSessionIds.delete(agent.id);
      return;
    }
    if (this._notifiedTerminalSessionIds.has(agent.id)) return;
    this._notifiedTerminalSessionIds.add(agent.id);
    const startedAt = status.startedAt ?? agent.createdAt;
    const elapsedMs = Math.max(0, status.completedAt - startedAt);
    const entry: CompletionEntry = {
      sessionId: agent.id,
      agent: agent.agentName,
      status: status.result.status,
      elapsedMs,
    };
    if (agent.label !== undefined) entry.label = agent.label;
    this._queue.push(entry);
    this._tryFlushForCurrentMode();
  };

  private _onDispatchEvent(dispatchMode: BackgroundNotifyMode, ctx: NotifierContext | undefined): void {
    if (this._disposed) return;
    this._captureCtx(ctx);
    const mode = this.deps.getMode();
    if (mode === "none") {
      this._queue = [];
      this._cancelRetry();
      return;
    }
    if (mode !== dispatchMode) return;
    if (mode === "auto") this._tryFlushAuto();
    else this._tryFlushSteer({ allowWithoutCtx: true, forceSteer: true });
  }

  private _captureCtx(ctx: NotifierContext | undefined): void {
    if (!ctx || this._ctx === ctx) return;
    this._ctx = ctx;
    this._ctxGen++;
  }

  private _tryFlushForCurrentMode(): void {
    if (this._disposed) return;
    const mode = this.deps.getMode();
    if (mode === "none") {
      this._queue = [];
      this._cancelRetry();
      return;
    }
    if (mode === "auto") this._tryFlushAuto();
    else this._tryFlushSteer();
  }

  private _tryFlushAuto(): void {
    if (this._disposed) return;
    const mode = this.deps.getMode();
    if (mode === "none") {
      this._queue = [];
      this._cancelRetry();
      return;
    }
    if (mode !== "auto") {
      this._cancelRetry();
      return;
    }
    if (this._queue.length === 0) {
      this._cancelRetry();
      return;
    }
    if (!this._ctx) return;
    if (!this._ctx.isIdle()) {
      this._scheduleAutoRetry();
      return;
    }
    this._cancelRetry();
    this._dispatch("auto");
  }

  private _tryFlushSteer(options: { allowWithoutCtx?: boolean; forceSteer?: boolean } = {}): void {
    if (this._disposed) return;
    const mode = this.deps.getMode();
    if (mode === "none") {
      this._queue = [];
      this._cancelRetry();
      return;
    }
    if (mode !== "steer") {
      this._cancelRetry();
      return;
    }
    if (this._queue.length === 0) return;
    this._cancelRetry();
    if (!this._ctx) {
      if (options.allowWithoutCtx) this._dispatch("steer");
      return;
    }
    this._dispatch(options.forceSteer || !this._ctx.isIdle() ? "steer" : "auto");
  }

  private _scheduleAutoRetry(): void {
    if (this._disposed) return;
    if (this._retryCancel) return;
    const gen = this._ctxGen;
    this._retryCancel = this._scheduleRetry(() => {
      this._retryCancel = undefined;
      if (this._disposed) return;
      if (this._ctxGen !== gen) return;
      this._tryFlushAuto();
    }, this._retryDelayMs);
  }

  private _cancelRetry(): void {
    if (this._retryCancel) {
      this._retryCancel();
      this._retryCancel = undefined;
    }
  }

  private _dispatch(dispatchMode: Exclude<BackgroundNotifyMode, "none">): void {
    if (this._queue.length === 0) return;
    const entries = this._queue;
    this._queue = [];
    const content = formatNotification(entries);
    this.deps.pi.sendMessage(
      {
        customType: "subagent-background-completion",
        content,
        details: { completions: entries.map(e => ({ ...e })) },
      },
      dispatchMode === "steer" ? { deliverAs: "steer" } : { triggerTurn: true },
    );
  }
}

function formatNotification(entries: CompletionEntry[]): string {
  const limit = getSubagentDisplaySettings().toolCallLabelMaxLength;
  const visible = entries.slice(0, MAX_LISTED_COMPLETIONS);
  const overflow = entries.length - visible.length;
  const header = `${entries.length} background subagent${entries.length === 1 ? "" : "s"} completed since the last notification:`;
  const lines = visible.map(entry => formatEntry(entry, limit));
  if (overflow > 0) lines.push(`- ... and ${overflow} more`);
  lines.push("");
  lines.push("Call subagent results with these sessionIds to retrieve output.");
  return [header, ...lines].join("\n");
}

function formatEntry(entry: CompletionEntry, labelLimit: number): string {
  const elapsed = formatElapsed(entry.elapsedMs);
  const labelPart = entry.label !== undefined ? ` (${truncate(entry.label, labelLimit)})` : "";
  return `- ${entry.agent}${labelPart} · ${entry.status} · ${elapsed} · sessionId ${entry.sessionId}`;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.floor(seconds - minutes * 60);
  return `${minutes}m${remSeconds.toString().padStart(2, "0")}s`;
}
