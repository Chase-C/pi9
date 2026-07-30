export const CONVERSATION_LIFECYCLE_STATES = ["active", "awaiting_join", "resumable", "terminal"] as const;

export type ConversationLifecycleState = (typeof CONVERSATION_LIFECYCLE_STATES)[number];
