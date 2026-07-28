import type { RunSnapshot } from "./conversation.js";

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

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens} tokens`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m tokens`;
}
