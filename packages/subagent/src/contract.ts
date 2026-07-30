import type { RunStatus, RunViewStatus } from "./conversation.js";
import type { ConversationId } from "./identifiers.js";
import type { SubagentAction, SubagentStatus } from "./schema.js";

export interface SubagentIdentity {
  readonly subagentId: ConversationId;
  readonly label: string;
  readonly agent: string;
}

interface CanonicalSubagentBase extends SubagentIdentity {
  readonly ok: true;
  readonly availableActions: readonly SubagentAction[];
}

export type CanonicalActiveSubagent = CanonicalSubagentBase & {
  readonly status: "queued" | "running";
  readonly joined?: never;
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
  readonly runStatus: RunViewStatus;
  readonly joined: boolean;
  readonly directlyOwned: boolean;
  readonly resumeAllowed: boolean;
  readonly removableSubtree: boolean;
}

export type FailureProjectionMode = "full" | { readonly maxLength: number };

const TRUNCATION_MARKER = "… [truncated]";

export function projectSubagentStatus(status: RunViewStatus): SubagentStatus {
  return projectSubagentRunStatus(status.kind === "done" ? status.outcome : status.kind);
}

export function projectSubagentRunStatus(status: RunStatus): SubagentStatus {
  if (status === "queued" || status === "running" || status === "completed") return status;
  return status === "aborted" ? "cancelled" : "failed";
}

export function projectAvailableActions(source: LiveSubagentProjectionSource): SubagentAction[] {
  if (!source.directlyOwned) return [];

  const status = projectSubagentStatus(source.runStatus);
  const actions: SubagentAction[] = [];
  if (isFinished(status) && source.joined && source.resumeAllowed) actions.push("resume");
  if (status === "running") actions.push("steer");
  if (status === "queued" || status === "running") actions.push("cancel");
  actions.push("inspect", "join");
  if (source.removableSubtree) actions.push("remove");
  return actions;
}

export function projectFailure(
  status: RunViewStatus,
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
  const status = projectSubagentStatus(source.runStatus);
  const availableActions = projectAvailableActions(source);
  const base = {
    ok: true as const,
    subagentId: source.subagentId,
    label: source.label,
    agent: source.agent,
  };
  if (status === "queued" || status === "running") {
    return { ...base, status, availableActions };
  }
  if (status === "failed") {
    const failure = projectFailure(source.runStatus, failureMode);
    if (!failure) throw new Error("Failed subagent projection requires a failure message.");
    return { ...base, status, joined: source.joined, availableActions, failure };
  }
  return { ...base, status, joined: source.joined, availableActions };
}

export function isFinishedSubagent(subagent: CanonicalLiveSubagent): subagent is CanonicalFinishedSubagent {
  return isFinished(subagent.status);
}

function isFinished(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
