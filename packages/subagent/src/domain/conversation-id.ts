import { CONVERSATION_ID_ADJECTIVES, CONVERSATION_ID_NOUNS } from "./identifier-word-lists.js";

declare const conversationIdBrand: unique symbol;
export type ConversationId = string & { readonly [conversationIdBrand]: true };

const adjectives: ReadonlySet<string> = new Set(CONVERSATION_ID_ADJECTIVES);
const nouns: ReadonlySet<string> = new Set(CONVERSATION_ID_NOUNS);

/** Recognizes only IDs from the conversation adjective-noun namespace. */
export function isConversationId(value: unknown): value is ConversationId {
  if (typeof value !== "string") return false;
  const words = value.split("-");
  return words.length === 2 && adjectives.has(words[0]) && nouns.has(words[1]);
}
