/** A run starts a conversation or resumes its existing SDK session. */
export type RunKind = "spawn" | "resume";
export type AttemptKind = RunKind;

export type AgentRunStatus =
  | "completed"
  | "error"
  | "aborted"
  | "skipped"
  | "interrupted";

export type AgentRunOutcome =
  | { readonly status: "completed"; readonly output?: string; readonly error?: never }
  | {
      readonly status: Exclude<AgentRunStatus, "completed">;
      readonly output?: never;
      readonly error?: string;
    };

export type AgentUpdateKind =
  | "status"
  | "message"
  | "tool"
  | "turn"
  | "usage"
  | "compaction"
  | "acknowledgement"
  | "observer";

export type RunNotificationState = "none" | "pending" | "notified";
