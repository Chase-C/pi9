import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";

export type SessionLayoutMode = "flat" | "tree";

export interface SessionRow {
  readonly session: AgentSnapshot;
  readonly depth: number;
  readonly contextOnly?: boolean;
}

export function projectSessions(
  sessions: readonly AgentSnapshot[],
  options: { mode: SessionLayoutMode; query: string },
): SessionRow[] {
  const directMatches = sessions.filter(session => sessionMatches(session, options.query));
  if (options.mode === "flat") return directMatches.map(session => ({ session, depth: 0 }));

  const allById = new Map(sessions.map(session => [session.id, session]));
  const includedIds = new Set(directMatches.map(session => session.id));
  for (const match of directMatches) {
    if (match.status.kind !== "running") continue;
    let parentId = match.parentSessionId;
    while (parentId) {
      const parent = allById.get(parentId);
      if (!parent || includedIds.has(parent.id)) break;
      includedIds.add(parent.id);
      parentId = parent.parentSessionId;
    }
  }
  const matches = sessions.filter(session => includedIds.has(session.id));
  const directIds = new Set(directMatches.map(session => session.id));
  const byId = new Map(matches.map(session => [session.id, session]));
  const childrenByParent = new Map<string, AgentSnapshot[]>();
  for (const session of matches) {
    if (session.status.kind !== "running" || !session.parentSessionId || !byId.has(session.parentSessionId)) continue;
    const children = childrenByParent.get(session.parentSessionId) ?? [];
    children.push(session);
    childrenByParent.set(session.parentSessionId, children);
  }

  const nested = new Set(Array.from(childrenByParent.values()).flat().map(session => session.id));
  const rows: SessionRow[] = [];
  const seen = new Set<string>();
  const visit = (session: AgentSnapshot, depth: number) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    rows.push({ session, depth, ...(!directIds.has(session.id) ? { contextOnly: true } : {}) });
    for (const child of childrenByParent.get(session.id) ?? []) visit(child, depth + 1);
  };
  for (const session of matches) if (!nested.has(session.id)) visit(session, 0);
  for (const session of matches) if (!seen.has(session.id)) visit(session, 0);
  return rows;
}

function sessionMatches(session: AgentSnapshot, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const status = session.status.kind === "done" ? session.status.outcome : session.status.kind;
  return [
    session.config.name,
    session.label,
    session.prompt,
    session.config.description,
    session.id,
    session.parentSessionId,
    session.dispatch,
    session.retention,
    status,
  ]
    .some(value => value?.toLowerCase().includes(normalized));
}

export function filterAgents(agents: readonly AgentConfig[], query: string): AgentConfig[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...agents];
  return agents.filter(agent => [
    agent.name,
    agent.description,
    agent.source,
    agent.model,
    ...(agent.tools ?? []),
    ...(agent.skills ?? []),
  ].some(value => value?.toLowerCase().includes(normalized)));
}
