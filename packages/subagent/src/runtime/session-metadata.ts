import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind } from "../domain/agent-lifecycle.js";
interface MetadataPi { appendEntry?(customType: string, data?: unknown): void }
interface MetadataSource { onAgentUpdate?(listener: (agent: Agent, kind: AgentUpdateKind) => void): () => void }
export function registerSubagentMetadataPersistence(pi: MetadataPi, source: MetadataSource): () => void {
  if (!pi.appendEntry || !source.onAgentUpdate) return () => {};
  const persisted = new Set<string>();
  return source.onAgentUpdate((agent, kind) => {
    if (kind !== "status") return; const snapshot = agent.snapshot(); const run = snapshot.runs.at(-1);
    if (!run || run.status.kind !== "done" || persisted.has(run.runId)) return; persisted.add(run.runId);
    pi.appendEntry!("subagent-run-index", projectSubagentRunIndex(snapshot));
  });
}
export function projectSubagentRunIndex(snapshot: ReturnType<Agent["snapshot"]>) {
  const run = snapshot.runs.at(-1); if (!run || run.status.kind !== "done") throw new Error("Cannot persist a non-terminal run.");
  return { version: 2, conversationId: snapshot.conversationId, runId: run.runId, agent: snapshot.config.name, ...(snapshot.label ? { label: snapshot.label } : {}), kind: run.kind, status: run.status.outcome, completedAt: run.status.completedAt, ...(run.status.startedAt !== undefined ? { startedAt: run.status.startedAt, elapsedMs: Math.max(0, run.status.completedAt - run.status.startedAt) } : {}) };
}
