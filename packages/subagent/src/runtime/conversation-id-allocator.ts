import type { ConversationId } from "../domain/conversation-id.js";
import { CONVERSATION_ID_ADJECTIVES, CONVERSATION_ID_NOUNS } from "../domain/identifier-word-lists.js";
import { IdAllocatorBase, type RandomIndex } from "./id-allocator-base.js";

/** Allocates unique conversation IDs for one owning runtime lifetime. */
export class ConversationIdAllocator extends IdAllocatorBase<ConversationId> {
  constructor(randomIndex?: RandomIndex) {
    super(CONVERSATION_ID_ADJECTIVES, CONVERSATION_ID_NOUNS, randomIndex);
  }
}
