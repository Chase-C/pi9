import type { GenerationStatus, GenerationViewStatus } from "./conversation.js";
import type { ConversationId } from "./identifiers.js";
import type { SubagentAction, SubagentStatus } from "./schema.js";

export interface SubagentIdentity {
  readonly subagentId: ConversationId;
  readonly label: string;
  readonly agent: string;
}

interface CanonicalSubagentBase extends SubagentIdentity {
  readonly ok: true;
  readonly generation: number;
  /** Snapshot-derived suggestions; state changes may invalidate them before the next action. */
  readonly actionHints: readonly SubagentAction[];
}

export type CanonicalActiveSubagent = CanonicalSubagentBase & {
  readonly status: "queued" | "running";
  readonly joined: false;
  readonly failure?: never;
};

export type CanonicalNonFailedSubagent = CanonicalSubagentBase & {
  readonly status: "completed" | "cancelled";
  readonly joined: boolean;
  readonly failure?: never;
};

export type CanonicalFailedSubagent = CanonicalSubagentBase & {
  readonly status: "failed";
  readonly joined: boolean;
  readonly failure: string;
};

export type CanonicalFinishedSubagent = CanonicalNonFailedSubagent | CanonicalFailedSubagent;
export type CanonicalLiveSubagent = CanonicalActiveSubagent | CanonicalFinishedSubagent;

export interface LiveSubagentProjectionSource {
  readonly subagentId: ConversationId;
  readonly label: string;
  readonly agent: string;
  readonly generation: number;
  readonly generationStatus: GenerationViewStatus;
  readonly joined: boolean;
  readonly directlyOwned: boolean;
  readonly inspectable: boolean;
  readonly resumeAllowed: boolean;
  readonly removableSubtree: boolean;
}

export type FailureProjectionMode = "full" | { readonly maxLength: number };

const TRUNCATION_MARKER = "… [truncated]";

export function projectSubagentStatus(status: GenerationViewStatus): SubagentStatus {
  return projectSubagentGenerationStatus(status.kind === "done" ? status.outcome : status.kind);
}

export function projectSubagentGenerationStatus(status: GenerationStatus): SubagentStatus {
  if (status === "queued" || status === "running" || status === "completed") return status;
  return status === "aborted" ? "cancelled" : "failed";
}

export function projectActionHints(source: LiveSubagentProjectionSource): SubagentAction[] {
  if (!source.directlyOwned) return source.inspectable ? ["inspect"] : [];

  const status = projectSubagentStatus(source.generationStatus);
  const actions: SubagentAction[] = [];
  if (isFinished(status) && source.joined && source.resumeAllowed) actions.push("resume");
  if (status === "running") actions.push("steer");
  if (status === "queued" || status === "running") actions.push("cancel");
  actions.push("inspect", "join");
  if (source.removableSubtree) actions.push("remove");
  return actions;
}

export function projectFailure(
  status: GenerationViewStatus,
  mode: FailureProjectionMode = "full",
): string | undefined {
  if (status.kind !== "done") return undefined;

  const detail = status.error?.trim();
  const message = status.outcome === "error"
    ? `Subagent failed${detail ? `: ${detail}` : "."}`
    : status.outcome === "interrupted"
      ? `Subagent was interrupted${detail ? `: ${detail}` : "."}`
      : status.outcome === "skipped"
        ? `Subagent execution was skipped${detail ? `: ${detail}` : "."}`
        : undefined;
  if (!message || mode === "full") return message;
  if (!Number.isInteger(mode.maxLength) || mode.maxLength < TRUNCATION_MARKER.length) {
    throw new Error(`Failure projection maxLength must be an integer of at least ${TRUNCATION_MARKER.length}.`);
  }
  if (message.length <= mode.maxLength) return message;
  return `${message.slice(0, mode.maxLength - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`;
}

export function projectLiveSubagent(
  source: LiveSubagentProjectionSource,
  failureMode: FailureProjectionMode = "full",
): CanonicalLiveSubagent {
  const status = projectSubagentStatus(source.generationStatus);
  const actionHints = projectActionHints(source);
  const base = {
    ok: true as const,
    subagentId: source.subagentId,
    label: source.label,
    agent: source.agent,
    generation: source.generation,
  };
  if (status === "queued" || status === "running") {
    return { ...base, status, joined: false, actionHints };
  }
  if (status === "failed") {
    const failure = projectFailure(source.generationStatus, failureMode);
    if (!failure) throw new Error("Failed subagent projection requires a failure message.");
    return { ...base, status, joined: source.joined, actionHints, failure };
  }
  return { ...base, status, joined: source.joined, actionHints };
}

export function isFinishedSubagent(subagent: CanonicalLiveSubagent): subagent is CanonicalFinishedSubagent {
  return isFinished(subagent.status);
}

function isFinished(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
