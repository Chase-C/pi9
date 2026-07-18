import type { AgentRunSnapshot, AgentSnapshot, AgentToolUse, AgentViewStatus } from "./agent-snapshot.js";
export function effectiveStatus(status: AgentViewStatus): string { return status.kind === "done" ? status.outcome : status.kind; }
export function getStartedAt(status: AgentViewStatus): number | undefined { return status.kind === "running" || status.kind === "done" ? status.startedAt : undefined; }
export function getQueuedAt(status: AgentViewStatus): number | undefined { return status.kind === "queued" ? status.queuedAt : undefined; }
export function getCompletedAt(status: AgentViewStatus): number | undefined { return status.kind === "done" ? status.completedAt : undefined; }
export function getSnippet(status: AgentViewStatus): string | undefined { return status.kind !== "done" ? undefined : status.outcome === "completed" ? status.output : status.error; }
export function getActiveTools(value: AgentSnapshot | AgentRunSnapshot): string[] { return history(value).filter(t => t.completedAt === undefined).map(t => t.name); }
export function getToolUseCount(value: AgentSnapshot | AgentRunSnapshot): number { return history(value).length; }
export function isActiveStatusKind(status: string): boolean { return status === "queued" || status === "running"; }
function history(value: AgentSnapshot | AgentRunSnapshot): readonly AgentToolUse[] { return "runs" in value ? value.runs.at(-1)?.activity.toolHistory ?? [] : value.activity.toolHistory; }
