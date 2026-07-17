/** A single fresh invocation or a continuation of a retained session. */
export type AttemptKind = "spawn" | "resume";

/** How one attempt is dispatched. */
export type AgentDispatch = "foreground" | "background";

/** Policy fixed for the lifetime of an Agent's conversation. */
export type ConversationRetentionPolicy = "retain" | "release";

export type AgentRetentionReason =
  "active" | "background-result" | "conversation-policy";

/** The sole domain decision for catalog, conversation, and lifecycle capabilities. */
export interface AgentRetentionDecision {
  readonly cataloged: boolean;
  readonly catalog: "transient" | "persistent";
  readonly keepConversation: boolean;
  readonly conversationAvailable: boolean;
  readonly canResume: boolean;
  readonly canRemove: boolean;
  readonly reasons: readonly AgentRetentionReason[];
}

/** Terminal outcomes shared by attempts, snapshots, and model-facing results. */
export type AgentRunStatus =
  "completed" | "error" | "aborted" | "skipped" | "interrupted";

/** Canonical discriminated terminal data stored on an Attempt. */
export type AgentRunOutcome =
  | {
      readonly status: "completed";
      readonly output?: string;
      readonly error?: never;
    }
  | {
      readonly status: Exclude<AgentRunStatus, "completed">;
      readonly output?: never;
      readonly error?: string;
    };

/** Coarse updates emitted while an agent attempt progresses. */
export type AgentUpdateKind =
  "status" | "message" | "tool" | "turn" | "usage" | "compaction";
