import type { AgentViewStatus } from "./agent-snapshot.js";

export function effectiveStatus(status: AgentViewStatus): string {
  return status.kind === "done" ? status.outcome : status.kind;
}
