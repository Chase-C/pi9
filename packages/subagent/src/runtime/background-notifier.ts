import { DEFAULT_SUBAGENT_SETTINGS, type BackgroundNotifyMode, type SubagentDisplaySettings } from "../config/settings.js";

import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind } from "../domain/agent-lifecycle.js";
import type { AgentManager } from "./agent-manager.js";
import {
  createBackgroundCompletionMessage,
  type BackgroundCompletion,
} from "../view/background-completion-message.js";

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
  manager: AgentManager;
  getMode: () => BackgroundNotifyMode;
  getDisplay?: () => SubagentDisplaySettings;
  scheduleRetry?: (fn: () => void, delayMs: number) => () => void;
}

const DEFAULT_RETRY_DELAY_MS = 500;

const defaultScheduleRetry = (fn: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(fn, delayMs);
  return () => clearTimeout(handle);
};

type FlushTrigger =
  | "auto-event"   // turn_end / agent_end
  | "steer-event"  // tool_execution_start
  | "generic"      // session_start or a fresh completion: act per current mode
  | "auto-retry";  // the idle-wait timer fired

type FlushAction =
  | { kind: "noop" }
  | { kind: "reset" }          // notifications off: drop the queue and stop waiting
  | { kind: "cancelRetry" }    // nothing to deliver: stop waiting
  | { kind: "scheduleRetry" }  // not idle yet: poll again later
  | { kind: "dispatch"; via: "auto" | "steer" };

export class BackgroundNotifier {
  private _queue: BackgroundCompletion[] = [];
  private _notifiedTerminalSessionIds = new Set<string>();
  private _unsubAgent: () => void = () => { };
  private _ctx: NotifierContext | undefined;
  private _retryCancel: (() => void) | undefined;
  private readonly _scheduleRetry: (fn: () => void, delayMs: number) => () => void;

  constructor(private readonly deps: BackgroundNotifierDeps) {
    this._scheduleRetry = deps.scheduleRetry ?? defaultScheduleRetry;
    // Guard: some callers (e.g. command tests) supply a partial manager without listener support.
    if (typeof deps.manager.onAgentUpdate === "function") {
      this._unsubAgent = deps.manager.onAgentUpdate(this._handleAgentUpdate);
    }
    if (typeof deps.pi.on === "function") {
      deps.pi.on("session_start", ((_event: unknown, ctx?: NotifierContext) => this._onSessionStart(ctx)) as PiEventHandler);
      deps.pi.on("session_shutdown", (() => this._onSessionShutdown()) as PiEventHandler);
      deps.pi.on("agent_end", ((_event: unknown, ctx?: NotifierContext) => this._onDispatchEvent("auto-event", ctx)) as PiEventHandler);
      deps.pi.on("turn_end", ((_event: unknown, ctx?: NotifierContext) => this._onDispatchEvent("auto-event", ctx)) as PiEventHandler);
      deps.pi.on("tool_execution_start", ((event: unknown, ctx?: NotifierContext) => this._onToolExecutionStart(event, ctx)) as PiEventHandler);
    }
  }

  /** Detach from the manager's update stream. Test-only: the pi extension API exposes no teardown hook. */
  unsubscribe(): void {
    this._unsubAgent();
  }

  private _onSessionStart(ctx: NotifierContext | undefined): void {
    this._ctx = ctx;
    this._cancelRetry();
    this._flush("generic");
  }

  private _onSessionShutdown(): void {
    this._ctx = undefined;
    this._cancelRetry();
  }

  private _handleAgentUpdate = (agent: Agent, kind: AgentUpdateKind): void => {
    if (kind !== "status") return;
    if (!agent.background) return;
    const status = agent.status;
    if (status.kind !== "done") {
      this._notifiedTerminalSessionIds.delete(agent.id);
      return;
    }
    if (this._notifiedTerminalSessionIds.has(agent.id)) return;
    this._notifiedTerminalSessionIds.add(agent.id);
    const startedAt = status.startedAt ?? agent.createdAt;
    const elapsedMs = Math.max(0, status.completedAt - startedAt);
    const entry: BackgroundCompletion = {
      sessionId: agent.id,
      agent: agent.agentName,
      status: status.outcome,
      elapsedMs,
    };
    if (agent.label !== undefined) entry.label = agent.label;
    this._queue.push(entry);
    this._flush("generic");
  };

  private _onToolExecutionStart(event: unknown, ctx: NotifierContext | undefined): void {
    const requestedIds = resultsSessionIds(event);
    if (requestedIds.size > 0) {
      this._queue = this._queue.filter(entry => !requestedIds.has(entry.sessionId));
    }
    this._onDispatchEvent("steer-event", ctx);
  }

  private _onDispatchEvent(trigger: "auto-event" | "steer-event", ctx: NotifierContext | undefined): void {
    if (ctx && this._ctx !== ctx) {
      this._ctx = ctx;
      this._cancelRetry();
    }
    this._flush(trigger);
  }

  private _flush(trigger: FlushTrigger): void {
    this._apply(this._decide(trigger));
  }

  /** Pure decision: resolve the live mode, queue and context into a single action. */
  private _decide(trigger: FlushTrigger): FlushAction {
    const mode = this.deps.getMode();
    if (mode === "none") return { kind: "reset" };

    // An opportunity only acts in the mode it serves; the retry is auto-only.
    if (trigger === "auto-event" && mode !== "auto") return { kind: "noop" };
    if (trigger === "steer-event" && mode !== "steer") return { kind: "noop" };
    if (trigger === "auto-retry" && mode !== "auto") return { kind: "cancelRetry" };

    if (this._queue.length === 0) {
      return mode === "auto" ? { kind: "cancelRetry" } : { kind: "noop" };
    }

    if (mode === "auto") {
      if (!this._ctx) return { kind: "noop" };
      if (!this._ctx.isIdle()) return { kind: "scheduleRetry" };
      return { kind: "dispatch", via: "auto" };
    }

    // steer: tool_execution_start may inject without a known idle context; other
    // openings deliver only when a context exists, as a turn when it happens to be idle.
    if (!this._ctx) {
      return trigger === "steer-event" ? { kind: "dispatch", via: "steer" } : { kind: "noop" };
    }
    const via = trigger === "steer-event" || !this._ctx.isIdle() ? "steer" : "auto";
    return { kind: "dispatch", via };
  }

  private _apply(action: FlushAction): void {
    switch (action.kind) {
      case "noop": return;
      case "reset":
        this._queue = [];
        this._cancelRetry();
        return;
      case "cancelRetry":
        this._cancelRetry();
        return;
      case "scheduleRetry":
        this._armRetry();
        return;
      case "dispatch":
        this._cancelRetry();
        this._dispatch(action.via);
        return;
    }
  }

  /** Single-flight: at most one pending idle retry; further arms are no-ops until it fires or is cancelled. */
  private _armRetry(): void {
    this._retryCancel ??= this._scheduleRetry(() => {
      this._retryCancel = undefined;
      this._flush("auto-retry");
    }, DEFAULT_RETRY_DELAY_MS);
  }

  private _cancelRetry(): void {
    this._retryCancel?.();
    this._retryCancel = undefined;
  }

  private _dispatch(via: "auto" | "steer"): void {
    if (this._queue.length === 0) return;
    const listedIds = new Set(this.deps.manager.listSessions().map(session => session.id));
    const entries = this._queue.filter(entry =>
      listedIds.has(entry.sessionId) && !this.deps.manager.isResultAcknowledged(entry.sessionId)
    );
    this._queue = [];
    if (entries.length === 0) return;
    const display = this.deps.getDisplay?.() ?? DEFAULT_SUBAGENT_SETTINGS.display;
    const message = createBackgroundCompletionMessage(entries, display);
    this.deps.pi.sendMessage(
      {
        customType: "subagent-background-completion",
        ...message,
      },
      via === "steer" ? { deliverAs: "steer" } : { triggerTurn: true },
    );
  }
}

function resultsSessionIds(event: unknown): Set<string> {
  if (!event || typeof event !== "object") return new Set();
  const { toolName, args } = event as { toolName?: unknown; args?: unknown };
  if (toolName !== "subagent" || !args || typeof args !== "object") return new Set();
  const { action, sessionIds } = args as { action?: unknown; sessionIds?: unknown };
  if (action !== "results" || !Array.isArray(sessionIds)) return new Set();
  return new Set(sessionIds.filter((id): id is string => typeof id === "string"));
}
