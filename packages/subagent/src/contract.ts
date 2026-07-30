import type { RunViewStatus } from "./conversation.js";
import type { ConversationId } from "./identifiers.js";
import type { SubagentAction, SubagentStatus } from "./schema.js";

export interface CanonicalLiveSubagent {
  readonly ok: true;
  readonly subagentId: ConversationId;
  readonly label: string;
  readonly agent: string;
  readonly status: SubagentStatus;
  readonly joined?: boolean;
  readonly availableActions: SubagentAction[];
  readonly failure?: string;
}

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
  if (status.kind !== "done") return status.kind;
  if (status.outcome === "completed") return "completed";
  if (status.outcome === "aborted") return "cancelled";
  return "failed";
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
  const failure = projectFailure(source.runStatus, failureMode);
  return {
    ok: true,
    subagentId: source.subagentId,
    label: source.label,
    agent: source.agent,
    status,
    ...(isFinished(status) ? { joined: source.joined } : {}),
    availableActions: projectAvailableActions(source),
    ...(failure ? { failure } : {}),
  };
}

function isFinished(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
