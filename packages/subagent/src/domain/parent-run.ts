import type { ConversationId } from "./conversation-id.js";
import type { RunId } from "./run-id.js";

/** The exact parent run that spawned a child conversation. */
export interface ParentRun {
  readonly conversationId: ConversationId;
  readonly runId: RunId;
}
