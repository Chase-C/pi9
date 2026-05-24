import type { AgentSnapshot } from "./agent-snapshot.js";

export type AgentRunStatus = "completed" | "error" | "aborted" | "skipped" | "interrupted";

/** Model-facing per-task result. Projected entirely from a terminal {@link AgentSnapshot}. */
export interface AgentResultJson {
  agent: string;
  label?: string;
  prompt: string;
  status: AgentRunStatus;
  output?: string;
  error?: string;
  model?: string;
  sessionId?: string;
  resumable: boolean;
  resumed: boolean;
  turns: number;
  tokens: number;
  elapsedMs: number;
}

/**
 * Projects a terminal snapshot into the model-facing result. `output`/`error` carry the
 * child's full untruncated text; `sessionId` is present only when the session is resumable.
 */
export function toResultJson(snapshot: AgentSnapshot): AgentResultJson {
  const status = snapshot.status;
  const done = status.kind === "done" ? status : undefined;
  const outcome = done?.outcome ?? "error";
  const elapsedMs = done?.startedAt !== undefined ? done.completedAt - done.startedAt : 0;
  const resumable = snapshot.config.resumable;
  return {
    agent: snapshot.config.name,
    ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
    prompt: snapshot.prompt ?? "",
    status: outcome,
    ...(done?.output !== undefined ? { output: done.output } : {}),
    ...(done?.error !== undefined ? { error: done.error } : {}),
    ...(snapshot.config.model !== undefined ? { model: snapshot.config.model } : {}),
    ...(resumable ? { sessionId: snapshot.id } : {}),
    resumable,
    resumed: Boolean(done?.resumed),
    turns: snapshot.activity.turns,
    tokens: snapshot.usage?.totalTokens ?? 0,
    elapsedMs,
  };
}

/**
 * The terminal data a settled attempt carries. The snapshot factory projects this onto the
 * `done` arm of {@link AgentSnapshot}; `toResultJson` then projects that into the result.
 */
export interface AgentOutcome {
  readonly status: AgentRunStatus;
  readonly output?: string;
  readonly error?: string;
  readonly resumed: boolean;
}

export type FinalizeRunArgs =
  | { status: "completed"; output?: string; error?: never; resumed?: boolean }
  | { status: Exclude<AgentRunStatus, "completed">; output?: never; error?: string; resumed?: boolean };

/** Normalizes finalize arguments into the terminal outcome stored on the attempt. */
export function toOutcome(args: FinalizeRunArgs): AgentOutcome {
  return {
    status: args.status,
    resumed: Boolean(args.resumed),
    ...(args.output !== undefined ? { output: args.output } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
  };
}

export type BackgroundResult =
  | { sessionId: string; ready: true; result: AgentResultJson }
  | { sessionId: string; ready: false; status: "queued" | "running"; elapsedMs: number; agent: string; label?: string }
  | { sessionId: string; error: string };
