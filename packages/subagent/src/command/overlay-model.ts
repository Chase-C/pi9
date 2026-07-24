import type { AgentConfig } from "../agents.js";
import type { ConversationSnapshot } from "../conversation.js";

export type ConversationLayoutMode = "flat" | "tree";

export interface ConversationRow {
  readonly conversation: ConversationSnapshot;
  readonly depth: number;
  readonly treePrefix?: string;
  readonly treeContinuation?: string;
  readonly contextOnly?: boolean;
}

export function projectConversations(
  conversations: readonly ConversationSnapshot[],
  options: { mode?: ConversationLayoutMode; query?: string } = {},
): ConversationRow[] {
  const mode = options.mode ?? "tree";
  const insertionOrder = new Map(conversations.map((conversation, index) => [conversation.conversationId, index]));
  const newestFirst = (left: ConversationSnapshot, right: ConversationSnapshot) =>
    right.createdAt - left.createdAt || (insertionOrder.get(right.conversationId) ?? 0) - (insertionOrder.get(left.conversationId) ?? 0);
  const directMatches = conversations.filter(conversation => conversationMatches(conversation, options.query ?? ""));
  if (mode === "flat") return [...directMatches].sort(newestFirst).map(conversation => ({ conversation, depth: 0 }));

  const allById = new Map(conversations.map(conversation => [conversation.conversationId, conversation]));
  const includedIds = new Set(directMatches.map(conversation => conversation.conversationId));
  for (const match of directMatches) {
    let parentId = match.parent?.conversationId;
    while (parentId) {
      const parent = allById.get(parentId);
      if (!parent || includedIds.has(parent.conversationId)) break;
      includedIds.add(parent.conversationId);
      parentId = parent.parent?.conversationId;
    }
  }

  const included = conversations.filter(conversation => includedIds.has(conversation.conversationId));
  const directIds = new Set(directMatches.map(conversation => conversation.conversationId));
  const byId = new Map(included.map(conversation => [conversation.conversationId, conversation]));
  const children = new Map<string, ConversationSnapshot[]>();
  for (const conversation of included) {
    const parentId = conversation.parent?.conversationId;
    if (!parentId || !byId.has(parentId)) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(conversation);
    children.set(parentId, siblings);
  }

  for (const siblings of children.values()) siblings.sort(newestFirst);

  const nested = new Set([...children.values()].flat().map(conversation => conversation.conversationId));
  const rows: ConversationRow[] = [];
  const seen = new Set<string>();
  const visit = (conversation: ConversationSnapshot, depth: number, ancestorLast: readonly boolean[] = [], isLast = true) => {
    if (seen.has(conversation.conversationId)) return;
    seen.add(conversation.conversationId);
    const guides = ancestorLast.map(last => last ? "   " : "│  ").join("");
    rows.push({
      conversation,
      depth,
      ...(depth ? {
        treePrefix: `${guides}${isLast ? "╰─ " : "├─ "}`,
        treeContinuation: `${guides}${isLast ? "   " : "│  "}`,
      } : {}),
      ...(!directIds.has(conversation.conversationId) ? { contextOnly: true } : {}),
    });
    const descendants = children.get(conversation.conversationId) ?? [];
    const childAncestors = depth ? [...ancestorLast, isLast] : [];
    descendants.forEach((child, index) => visit(child, depth + 1, childAncestors, index === descendants.length - 1));
  };
  for (const conversation of included.filter(conversation => !nested.has(conversation.conversationId)).sort(newestFirst)) visit(conversation, 0);
  for (const conversation of included.filter(conversation => !seen.has(conversation.conversationId)).sort(newestFirst)) visit(conversation, 0);
  return rows;
}

export function filterAgents(agents: readonly AgentConfig[], query: string): AgentConfig[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized ? agents.filter(agent => [
    agent.name,
    agent.description,
    agent.source,
    agent.model,
    agent.thinking,
    agent.sourcePath,
    ...(agent.tools ?? []),
    ...(agent.skills ?? []),
  ].some(value => value?.toLowerCase().includes(normalized))) : [...agents];
  return filtered.sort((left, right) => left.name.localeCompare(right.name));
}

function conversationMatches(conversation: ConversationSnapshot, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const values = [
    conversation.conversationId,
    conversation.label,
    conversation.config.name,
    conversation.config.description,
    conversation.config.source,
    conversation.config.model,
    conversation.config.thinking,
    conversation.parent?.conversationId,
    conversation.parent?.runId,
    conversation.effectiveConfig?.model,
    conversation.effectiveConfig?.thinking,
    conversation.effectiveConfig?.cwd,
    ...(conversation.config.tools ?? []),
    ...(conversation.config.skills ?? []),
    ...(conversation.effectiveConfig?.tools ?? []),
    ...(conversation.effectiveConfig?.skills ?? []),
  ];
  for (const run of conversation.runs) {
    values.push(
      run.runId,
      run.kind,
      run.prompt,
      run.status.kind === "done" ? run.status.outcome : run.status.kind,
      run.activity.messageSnippet,
      ...run.activity.toolHistory.flatMap(tool => [tool.name, tool.inputSummary]),
    );
  }
  return values.some(value => value?.toLowerCase().includes(normalized));
}
