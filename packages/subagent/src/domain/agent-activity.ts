import { Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { AgentToolUse, AgentActivitySnapshot } from "./agent-snapshot.js";
import type { AgentUpdateKind } from "./agent.js";

const DefaultUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export type AgentActivityListener = (kind: AgentUpdateKind) => void;

export class AgentActivity {

  private _message: string = "";
  private _turns: number = 0;
  private _toolHistory = new Array<AgentToolUse>();
  private _compactions: number = 0;
  private _latestUsage: Usage = DefaultUsage;
  private _nextSyntheticToolId = 0;

  constructor(private readonly onChange: AgentActivityListener) {}

  get message() { return this._message }

  get usage(): Usage { return this._latestUsage }

  snapshot(): AgentActivitySnapshot {
    return {
      messageSnippet: this._message || undefined,
      turns: this._turns,
      compactions: this._compactions,
      toolHistory: this._toolHistory.map(tool => ({ ...tool })),
    };
  }

  subscribe(session: AgentSession): () => void {
    return session.subscribe(event => {
      if (event.type === "compaction_end" && !event.aborted && event.result) {
        this._compactions += 1;
        this.onChange("compaction");
      }
      else if (event.type === "message_start") {
        this._message = "";
      }
      else if (event.type === "message_end" && event.message.role === "assistant") {
        // Each assistant message carries the usage for that single API call, where the
        // input/cache fields already cover the whole conversation re-sent that call. Summing
        // across calls would re-count the growing context every round, so we take the latest
        // call's usage as the run's current context size rather than accumulating.
        this._latestUsage = event.message.usage;
        this.onChange("usage");
      }
      else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this._message += event.assistantMessageEvent.delta;
        this.onChange("message");
      }
      else if (event.type === "tool_execution_start") {
        this._startToolUse(event);
        this.onChange("tool");
      }
      else if (event.type === "tool_execution_end") {
        this._finishToolUse(event);
        this.onChange("tool");
      }
      else if (event.type === "turn_end") {
        this._turns += 1;
        this.onChange("turn");
      }
    });
  }

  private _startToolUse(event: { toolCallId?: string; toolName: string; args?: unknown }) {
    const inputSummary = toolInputSummary(event.toolName, event.args);
    this._toolHistory.push({
      id: event.toolCallId ?? `tool-${++this._nextSyntheticToolId}`,
      name: event.toolName,
      startedAt: Date.now(),
      ...(inputSummary ? { inputSummary } : {}),
    });
  }

  private _finishToolUse(event: { toolCallId?: string; toolName?: string; isError?: boolean }) {
    const completedAt = Date.now();
    const index = this._findActiveToolUseIndex(event);
    if (index < 0) return;
    const toolUse = this._toolHistory[index];
    this._toolHistory[index] = { ...toolUse, completedAt, isError: Boolean(event.isError) };
  }

  private _findActiveToolUseIndex(event: { toolCallId?: string; toolName?: string }) {
    for (let i = this._toolHistory.length - 1; i >= 0; i--) {
      const toolUse = this._toolHistory[i];
      if (toolUse.completedAt !== undefined) continue;
      if (event.toolCallId && toolUse.id !== event.toolCallId) continue;
      if (!event.toolCallId && event.toolName && toolUse.name !== event.toolName) continue;
      return i;
    }
    return -1;
  }
}

function toolInputSummary(toolName: string, args: unknown): string | undefined {
  const input = asRecord(args);
  if (!input) return undefined;

  switch (toolName) {
    case "read":
      return joinParts([stringValue(input.path), numericPart("offset", input.offset), numericPart("limit", input.limit)]);
    case "write":
    case "ls":
      return stringValue(input.path);
    case "edit":
      return joinParts([stringValue(input.path), countPart(input.edits, "edit")]);
    case "bash":
      return stringValue(input.command);
    case "grep":
      return joinParts([quote(stringValue(input.pattern)), input.path ? `in ${String(input.path)}` : undefined]);
    case "find":
      return joinParts([stringValue(input.pattern) ?? stringValue(input.name), input.path ? `in ${String(input.path)}` : undefined]);
    case "subagent":
      return joinParts([stringValue(input.action), countPart(input.tasks, "task") ?? countPart(input.sessionIds, "session")]);
    default:
      return fallbackSummary(input);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? compactOneLine(value) : undefined;
}

function numericPart(label: string, value: unknown): string | undefined {
  return typeof value === "number" ? `${label} ${value}` : undefined;
}

function countPart(value: unknown, noun: string): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return `${value.length} ${noun}${value.length === 1 ? "" : "s"}`;
}

function quote(value: string | undefined): string | undefined {
  return value ? `"${value}"` : undefined;
}

function joinParts(parts: Array<string | undefined>): string | undefined {
  const summary = parts.filter((part): part is string => Boolean(part)).join(" ");
  return summary || undefined;
}

function compactOneLine(value: string | undefined): string | undefined {
  return value?.replace(/\\\s+/g, " ").replace(/\s+/g, " ").trim();
}

function fallbackSummary(input: Record<string, unknown>): string | undefined {
  const safe = Object.entries(input)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 3)
    .map(([key, value]) => `${key}:${String(value).replace(/\s+/g, " ")}`)
    .join(" ");
  return safe || undefined;
}
