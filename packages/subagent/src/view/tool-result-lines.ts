import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { effectiveStatus } from "../domain/agent-decisions.js";
import { toResult } from "../domain/agent-result.js";
import type { SubagentDisplaySettings } from "../config/settings.js";
import type { SubagentDetails } from "./details.js";
import { SubagentTextComponent, type DisplayLine } from "./text-component.js";
import { formatRunConversationLine } from "./conversation-lines.js";

export interface RunSummary { running: number; queued: number; finished: number; elapsed: string }
function elapsed(start: number, end: number): string { const seconds = Math.max(0, Math.floor((end - start) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
export function runSummary(details: SubagentDetails, now = Date.now()): RunSummary | undefined {
  const runs = details.view === "run" ? details.conversations.flatMap(c => c.runs) : details.view === "join" ? details.entries.flatMap(e => "snapshot" in e ? [e.snapshot.runs.find(r => r.runId === e.runId) ?? e.snapshot.runs.at(-1)].filter(Boolean) : []) : undefined;
  if (!runs) return undefined;
  let running = 0, queued = 0, finished = 0, earliest = details.view === "run" ? details.runStartedAt ?? now : now;
  for (const run of runs) { if (!run) continue; if (run.status.kind === "running") running++; else if (run.status.kind === "queued") queued++; else finished++; const start = run.status.kind === "queued" ? run.status.queuedAt : run.status.startedAt ?? run.createdAt; earliest = Math.min(earliest, start); }
  return { running, queued, finished, elapsed: elapsed(earliest, now) };
}

export function formatSubagentToolLines(details: SubagentDetails, expanded = false, now = Date.now(), _display?: SubagentDisplaySettings): string[] {
  switch (details.view) {
    case "error": return details.errors ?? [];
    case "agents": return details.agents.length ? details.agents.map(a => `${a.name}${a.description ? ` · ${a.description}` : ""}`) : ["No agents."];
    case "runs-started": return [`Started ${details.count} run${details.count === 1 ? "" : "s"}.`, ...details.handles.map(h => `${h.agent}${h.label ? ` · ${h.label}` : ""} · ${h.runId} · ${h.conversationId}`), ...(details.errors ?? []).map(e => `${e.agent}: ${e.error}`)];
    case "inventory": return details.conversations.length ? details.conversations.flatMap(conversation => conversation.runs.map(run => formatRunConversationLine(conversation, run))) : ["No conversations."];
    case "run": return renderConversations(details.conversations, expanded, true);
    case "join": return details.entries.flatMap(entry => {
      if ("error" in entry) return [`${entry.runId} · ${entry.conversationId} · ${entry.error}`];
      const result = toResult(entry.snapshot, entry.runId ?? entry.snapshot.runs.at(-1)!.runId);
      return [`${result.agent} · ${result.runId} · ${result.conversationId} · ${result.status}`, ...(expanded ? [result.output ?? result.error ?? ""] : [])].filter(Boolean);
    });
    case "remove-summary": return [`Removed ${details.summary.removed} conversation${details.summary.removed === 1 ? "" : "s"}${details.summary.aborted ? ` · aborted ${details.summary.aborted}` : ""}.`, ...details.summary.conversationIds.map(id => `conversation ${id}`), ...(details.summary.errors ?? []).map(e => `${e.conversationId}: ${e.error}`)];
  }
}
function renderConversations(conversations: AgentSnapshot[], expanded: boolean, fullOutput: boolean): string[] {
  return conversations.flatMap(conversation => conversation.runs.flatMap(run => {
    const lines = [formatRunConversationLine(conversation, run)];
    if (expanded) lines.push(`prompt: ${run.prompt}`);
    if (fullOutput && run.status.kind === "done") lines.push(run.status.output ?? run.status.error ?? "");
    return lines.filter(Boolean);
  }));
}
export function createSubagentTextComponent(details: SubagentDetails, expanded: boolean, theme: Theme | undefined, now = Date.now(), display?: SubagentDisplaySettings): Component | undefined {
  if (details.view === "error") return undefined;
  const lines: DisplayLine[] = formatSubagentToolLines(details, expanded, now, display).map(text => ({ text }));
  return new SubagentTextComponent(lines, theme);
}
