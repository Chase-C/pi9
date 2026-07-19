import type { AgentSnapshot } from "../domain/agent-snapshot.js";

export interface ConversationRow {
  readonly conversation: AgentSnapshot;
  readonly depth: number;
}

/** Projects a conversation tree without requiring retained parents. */
export function projectConversations(conversations: readonly AgentSnapshot[]): ConversationRow[] {
  const byId = new Map(conversations.map(conversation => [conversation.conversationId, conversation]));
  const children = new Map<string, AgentSnapshot[]>();
  for (const conversation of conversations) {
    const parentId = conversation.parent?.conversationId;
    if (!parentId || !byId.has(parentId)) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(conversation);
    children.set(parentId, siblings);
  }

  const nested = new Set(
    [...children.values()].flat().map(conversation => conversation.conversationId),
  );
  const rows: ConversationRow[] = [];
  const seen = new Set<string>();
  const visit = (conversation: AgentSnapshot, depth: number) => {
    if (seen.has(conversation.conversationId)) return;
    seen.add(conversation.conversationId);
    rows.push({ conversation, depth });
    for (const child of children.get(conversation.conversationId) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const conversation of conversations) {
    if (!nested.has(conversation.conversationId)) visit(conversation, 0);
  }
  return rows;
}
