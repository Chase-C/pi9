import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot, RunStatus } from "./conversation.js";
import type { SubagentStatus } from "./schema.js";

export function runElapsedMs(run: RunSnapshot, now = Date.now()): number {
  const start = run.status.kind === "queued" ? run.status.queuedAt
    : run.status.kind === "running" ? run.status.startedAt
    : run.status.startedAt ?? run.createdAt;
  const end = run.status.kind === "done" ? run.status.completedAt : now;
  return Math.max(0, end - start);
}

export function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds - minutes * 60);
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

export function truncateText(value: string, limit: number, trimEnd = false): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const truncated = text.slice(0, Math.max(0, limit - 1));
  return `${trimEnd ? truncated.trimEnd() : truncated}…`;
}

/** The shared status palette for every run-status surface. */
export function statusColor(status: RunStatus | SubagentStatus): ThemeColor {
  if (status === "completed") return "success";
  if (status === "error" || status === "failed") return "error";
  if (status === "skipped") return "dim";
  return "warning";
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens} tokens`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m tokens`;
}
