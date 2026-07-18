import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind } from "../domain/agent-lifecycle.js";

export interface SubagentEventBus { emit(event: string, data: unknown): void }
export interface SubagentLifecycleEventSource { onAgentUpdate?(listener: (agent: Agent, kind: AgentUpdateKind) => void): () => void }

/** Emits lifecycle events keyed by exact conversation and run identities. */
export function registerSubagentLifecycleEvents(events: SubagentEventBus | undefined, source: SubagentLifecycleEventSource): () => void {
  if (!events?.emit || !source.onAgentUpdate) return () => {};
  const seen = new Set<string>();
  return source.onAgentUpdate((agent, kind) => {
    const snapshot = agent.snapshot(); const run = snapshot.runs.at(-1);
    events.emit("subagent:updated", { conversationId: snapshot.conversationId, runId: run?.runId, kind, snapshot });
    if (kind !== "status" || !run) return;
    const status = run.status;
    const key = `${run.runId}:${status.kind}:${status.kind === "queued" ? status.queuedAt : status.kind === "running" ? status.startedAt : status.completedAt}`;
    if (seen.has(key)) return; seen.add(key);
    const event = status.kind === "queued" ? "subagent:queued" : status.kind === "running" ? "subagent:started" : "subagent:completed";
    events.emit(event, { conversationId: snapshot.conversationId, runId: run.runId, ...(status.kind === "done" ? { outcome: status.outcome } : {}), snapshot });
  });
}
