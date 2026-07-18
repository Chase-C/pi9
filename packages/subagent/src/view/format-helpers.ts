import type { AgentSnapshot, AgentToolUse } from "../domain/agent-snapshot.js";

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string { return `${count} ${count === 1 ? singular : pluralForm}`; }
export function formatElapsed(start: number, end = Date.now()): string { const seconds = Math.max(0, Math.floor((end - start) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
export function formatToolUseLine(tool: AgentToolUse): string { return `${tool.name}${tool.inputSummary ? ` · ${tool.inputSummary}` : ""}`; }
export function orderAsTree(conversations: readonly AgentSnapshot[]): Array<{ agent: AgentSnapshot; depth: number }> {
  const byId = new Map(conversations.map(c => [c.conversationId, c])); const children = new Map<string, AgentSnapshot[]>();
  for (const c of conversations) if (c.parentConversationId && byId.has(c.parentConversationId)) children.set(c.parentConversationId, [...(children.get(c.parentConversationId) ?? []), c]);
  const childIds = new Set([...children.values()].flat().map(c => c.conversationId)); const result: Array<{ agent: AgentSnapshot; depth: number }> = []; const seen = new Set<string>();
  const visit = (agent: AgentSnapshot, depth: number) => { if (seen.has(agent.conversationId)) return; seen.add(agent.conversationId); result.push({ agent, depth }); for (const child of children.get(agent.conversationId) ?? []) visit(child, depth + 1); };
  for (const c of conversations) if (!childIds.has(c.conversationId)) visit(c, 0); return result;
}
export function expandedLines(lines: string[], expanded: boolean): string[] { return expanded ? lines : lines.slice(0, 1); }
