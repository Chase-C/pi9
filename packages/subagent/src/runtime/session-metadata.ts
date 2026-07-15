import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../config/settings.js";
import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind } from "../domain/agent-lifecycle.js";
import { compact } from "../view/view-helpers.js";

interface MetadataPi {
  appendEntry?(customType: string, data?: unknown): void;
}

interface MetadataSource {
  onAgentUpdate?(listener: (agent: Agent, kind: AgentUpdateKind) => void): () => void;
}

export function registerSubagentMetadataPersistence(
  pi: MetadataPi,
  source: MetadataSource,
  getDisplay: () => SubagentDisplaySettings = () => DEFAULT_SUBAGENT_SETTINGS.display,
): () => void {
  if (typeof pi.appendEntry !== "function" || typeof source.onAgentUpdate !== "function") return () => { };

  const persisted = new Set<string>();
  return source.onAgentUpdate((agent, kind) => {
    if (kind !== "status") return;
    const snapshot = agent.snapshot();
    if (snapshot.status.kind !== "done") return;

    const key = `${snapshot.id}:${snapshot.status.completedAt}:${snapshot.status.outcome}`;
    if (persisted.has(key)) return;
    persisted.add(key);

    pi.appendEntry?.("subagent-session-index", projectSubagentSessionIndex(snapshot, getDisplay()));
  });
}

export function projectSubagentSessionIndex(snapshot: ReturnType<Agent["snapshot"]>, display: SubagentDisplaySettings) {
  const status = snapshot.status;
  if (status.kind !== "done") throw new Error("Cannot persist a non-terminal subagent session.");
  const startedAt = status.startedAt;
  return {
    version: 1,
    sessionId: snapshot.id,
    agent: snapshot.config.name,
    ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
    status: status.outcome,
    dispatch: snapshot.dispatch,
    retention: snapshot.retention,
    completedAt: status.completedAt,
    ...(startedAt !== undefined ? { startedAt, elapsedMs: Math.max(0, status.completedAt - startedAt) } : {}),
    ...(snapshot.prompt !== undefined ? { promptPreview: compact(snapshot.prompt, display.promptPreviewLength) } : {}),
    ...(status.output !== undefined ? { outputSnippet: compact(status.output, display.outputSnippetLength) } : {}),
    ...(status.error !== undefined ? { errorSnippet: compact(status.error, display.outputSnippetLength) } : {}),
  };
}
