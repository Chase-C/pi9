/** A single fresh invocation or a continuation of a retained session. */
export type AttemptKind = "spawn" | "resume";

/** Terminal outcomes shared by attempts, snapshots, and model-facing results. */
export type AgentRunStatus =
  | "completed"
  | "error"
  | "aborted"
  | "skipped"
  | "interrupted";

/** Canonical discriminated terminal data stored on an Attempt. */
export type AgentRunOutcome =
  | { readonly status: "completed"; readonly output?: string; readonly error?: never }
  | { readonly status: Exclude<AgentRunStatus, "completed">; readonly output?: never; readonly error?: string };

/** Coarse updates emitted while an agent attempt progresses. */
export type AgentUpdateKind = "status" | "retention" | "message" | "tool" | "turn" | "usage" | "compaction";
