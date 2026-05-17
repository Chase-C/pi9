import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind, AgentRunStatus } from "../domain/agent-view.js";
import type { AgentUpdateListener } from "./agent-manager.js";
import type { BackgroundNotifyMode } from "../ui/settings.js";
import { getSubagentDisplaySettings } from "../view/view-helpers.js";

export interface NotifierManager {
  onAgentUpdate?(listener: AgentUpdateListener): () => void;
}

const MAX_LISTED_COMPLETIONS = 20;

export interface NotifierPi {
  on(event: "agent_end", handler: (event: unknown) => void): void;
  on(event: "tool_execution_start", handler: (event: unknown) => void): void;
  sendMessage(
    message: { customType: string; content: string; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

export interface BackgroundNotifierDeps {
  pi: NotifierPi;
  manager: NotifierManager;
  getMode: () => BackgroundNotifyMode;
}

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

  constructor(private readonly deps: BackgroundNotifierDeps) {
    if (typeof deps.manager.onAgentUpdate === "function") {
      this._unsubAgent = deps.manager.onAgentUpdate(this._handleAgentUpdate);
    }
    if (typeof deps.pi.on === "function") {
      deps.pi.on("agent_end", () => this._onDispatchEvent("end-of-turn"));
      deps.pi.on("tool_execution_start", () => this._onDispatchEvent("next-tool-call"));
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._unsubAgent();
    this._queue = [];
    this._notifiedTerminalSessionIds.clear();
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
  };

  private _onDispatchEvent(dispatchMode: BackgroundNotifyMode): void {
    if (this._disposed) return;
    const mode = this.deps.getMode();
    if (mode === "none") {
      this._queue = [];
      return;
    }
    if (mode !== dispatchMode) return;
    this._dispatch(dispatchMode);
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
      dispatchMode === "next-tool-call" ? { deliverAs: "steer" } : { triggerTurn: true },
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
