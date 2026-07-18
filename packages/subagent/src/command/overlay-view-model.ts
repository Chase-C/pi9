import type { AgentSnapshot } from "../domain/agent-snapshot.js";

export type ConversationLayoutMode = "flat" | "tree";
export interface ConversationRow { readonly conversation: AgentSnapshot; readonly depth: number; readonly contextOnly?: boolean }

/** Projects conversations without assuming that a parent is still present in the catalog. */
export function projectConversations(conversations: readonly AgentSnapshot[], options: { mode: ConversationLayoutMode; query: string }): ConversationRow[] {
  const matches = conversations.filter(c => conversationMatches(c, options.query));
  if (options.mode === "flat") return matches.map(conversation => ({ conversation, depth: 0 }));
  const byId = new Map(matches.map(c => [c.conversationId, c]));
  const children = new Map<string, AgentSnapshot[]>();
  for (const conversation of matches) {
    const parent = conversation.parentConversationId;
    if (!parent || !byId.has(parent)) continue;
    const values = children.get(parent) ?? []; values.push(conversation); children.set(parent, values);
  }
  const nested = new Set([...children.values()].flat().map(c => c.conversationId));
  const rows: ConversationRow[] = []; const seen = new Set<string>();
  const visit = (conversation: AgentSnapshot, depth: number) => { if (seen.has(conversation.conversationId)) return; seen.add(conversation.conversationId); rows.push({ conversation, depth }); for (const child of children.get(conversation.conversationId) ?? []) visit(child, depth + 1); };
  for (const conversation of matches) if (!nested.has(conversation.conversationId)) visit(conversation, 0);
  return rows;
}

function conversationMatches(conversation: AgentSnapshot, query: string): boolean {
  const needle = query.trim().toLowerCase(); if (!needle) return true;
  return [conversation.config.name, conversation.label, conversation.config.description, conversation.conversationId,
    conversation.parentConversationId, ...conversation.runs.flatMap(run => [run.runId, run.prompt, effectiveRunStatus(run)])]
    .some(value => value?.toLowerCase().includes(needle));
}
function effectiveRunStatus(run: AgentSnapshot["runs"][number]): string { return run.status.kind === "done" ? run.status.outcome : run.status.kind; }

export function filterAgents<T extends { name: string; description?: string }>(agents: readonly T[], query: string): T[] { const needle = query.trim().toLowerCase(); return needle ? agents.filter(a => [a.name, a.description].some(v => v?.toLowerCase().includes(needle))) : [...agents]; }
