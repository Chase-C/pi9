import { getQueuedAt, getStartedAt } from "./agent-decisions.js";
import type { AgentRunStatus } from "./agent-lifecycle.js";
import type { AgentEffectiveConfig, AgentSnapshot } from "./agent-snapshot.js";

/** Model-facing per-task result. Projected entirely from a terminal {@link AgentSnapshot}. */
export interface AgentResult {
  agent: string;
  label?: string;
  prompt: string;
  status: AgentRunStatus;
  output?: string;
  error?: string;
  model?: string;
  effectiveConfig?: AgentEffectiveConfig;
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
export function toResult(snapshot: AgentSnapshot): AgentResult {
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
    ...(snapshot.effectiveConfig ? { effectiveConfig: snapshot.effectiveConfig } : {}),
    ...(resumable ? { sessionId: snapshot.id } : {}),
    resumable,
    resumed: Boolean(done?.resumed),
    turns: snapshot.activity.turns,
    tokens: snapshot.usage?.totalTokens ?? 0,
    elapsedMs,
  };
}

/**
 * Render-side entry for the `results` view (shared by `action: "run"` and `action: "results"`).
 * A live or terminal snapshot renders through the shared snapshot row path; an unknown id renders
 * as an error line. The model-facing JSON is projected from this by {@link toResults}, so the
 * renderer never depends on {@link AgentResult}.
 */
export type ResultEntry =
  | { snapshot: AgentSnapshot }
  | { sessionId: string; error: string };

/** Model-facing per-entry JSON for the `results` envelope, projected from {@link ResultEntry}. */
export type BackgroundResult =
  | { sessionId?: string; ready: true; result: AgentResult }
  | { sessionId: string; ready: false; status: "queued" | "running"; elapsedMs: number; agent: string; label?: string }
  | { sessionId: string; error: string };

/**
 * Projects render entries into the model-facing `results` array. Terminal snapshots become the
 * `{ ready: true, result }` projection; pending snapshots become progress metadata; unknown ids
 * pass through as errors. `exposeId` surfaces the top-level `sessionId` of a ready entry even when
 * it isn't resumable — the `results` action echoes the requested id, while a synchronous `run`
 * only surfaces collectable (resumable) ids.
 */
export function toResults(
  entries: readonly ResultEntry[],
  opts: { exposeId?: boolean } = {},
): BackgroundResult[] {
  return entries.map(entry => {
    if ("error" in entry) return { sessionId: entry.sessionId, error: entry.error };
    const { snapshot } = entry;
    const status = snapshot.status;
    if (status.kind === "done") {
      const result = toResult(snapshot);
      const sessionId = opts.exposeId ? snapshot.id : result.sessionId;
      return { ...(sessionId !== undefined ? { sessionId } : {}), ready: true, result };
    }
    const beginAt = getStartedAt(status) ?? getQueuedAt(status) ?? snapshot.createdAt;
    return {
      sessionId: snapshot.id,
      ready: false,
      status: status.kind,
      elapsedMs: Math.max(0, Date.now() - beginAt),
      agent: snapshot.config.name,
      ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
    };
  });
}
