import type { Agent, AgentUpdateKind } from "../domain/agent.js";

export interface SubagentEventBus {
  emit(event: string, data: unknown): void;
}

export interface SubagentLifecycleEventSource {
  onAgentUpdate?(listener: (agent: Agent, kind: AgentUpdateKind) => void): () => void;
}

type SeenTerminal = { outcome: string; completedAt: number };

export function registerSubagentLifecycleEvents(
  events: SubagentEventBus | undefined,
  source: SubagentLifecycleEventSource,
): () => void {
  if (!events || typeof events.emit !== "function" || typeof source.onAgentUpdate !== "function") return () => { };

  const seenQueued = new Set<string>();
  const seenStarted = new Set<string>();
  const seenTerminal = new Map<string, SeenTerminal>();

  return source.onAgentUpdate((agent, kind) => {
    const snapshot = agent.snapshot();
    const payload = { sessionId: snapshot.id, kind, snapshot };
    events.emit("subagent:updated", payload);

    if (kind !== "status") return;

    if (snapshot.status.kind === "queued") {
      if (seenQueued.has(snapshot.id)) return;
      seenQueued.add(snapshot.id);
      events.emit("subagent:queued", { sessionId: snapshot.id, snapshot });
      return;
    }

    if (snapshot.status.kind === "running") {
      if (seenStarted.has(snapshot.id)) return;
      seenStarted.add(snapshot.id);
      events.emit("subagent:started", { sessionId: snapshot.id, snapshot });
      return;
    }

    const previous = seenTerminal.get(snapshot.id);
    const current = { outcome: snapshot.status.outcome, completedAt: snapshot.status.completedAt };
    if (previous?.outcome === current.outcome && previous.completedAt === current.completedAt) return;
    seenTerminal.set(snapshot.id, current);
    events.emit("subagent:completed", { sessionId: snapshot.id, outcome: current.outcome, snapshot });
  });
}
