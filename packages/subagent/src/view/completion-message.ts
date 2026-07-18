import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../config/settings.js";
import type { AgentRunStatus } from "../domain/agent-lifecycle.js";

/** The current serializable completion summary shared by notification production and rendering. */
export interface CompletionNotification {
  runId: string;
  conversationId: string;
  agent: string;
  label?: string;
  status: AgentRunStatus;
  elapsedMs: number;
}

export interface CompletionNotificationMessageDetails {
  completions: CompletionNotification[];
}

export interface CompletionNotificationMessage {
  content: string;
  details: CompletionNotificationMessageDetails;
}

export type CompletionNotificationMessagePayload = CompletionNotificationMessage;

const MAX_LISTED_COMPLETIONS = 20;
const RESULTS_INSTRUCTION = "Call subagent join with these runIds to retrieve output.";

type EntrySurface = "notification" | "renderer";

/**
 * Creates the complete custom message sent for a batch of run completions.
 *
 * The notification text and details are projected from the same copied entries so the producer
 * and renderer cannot drift on the payload shape. The renderer intentionally applies its own
 * collapsed/expanded presentation to preserve the existing themed surfaces.
 */
export function createCompletionNotificationMessage(
  entries: readonly CompletionNotification[],
  display: SubagentDisplaySettings = DEFAULT_SUBAGENT_SETTINGS.display,
): CompletionNotificationMessagePayload {
  const completions = entries.map(copyCompletionNotification);
  return {
    content: formatNotificationContent(completions, display),
    details: { completions },
  };
}

export function formatCompletionNotificationMessage(
  details: CompletionNotificationMessageDetails,
  expanded: boolean,
  theme: Pick<Theme, "fg"> | undefined,
  display: SubagentDisplaySettings = DEFAULT_SUBAGENT_SETTINGS.display,
): string {
  const completions = details.completions;
  const header = formatCompletionHeader(completions.length, expanded);
  const lines = completions.map(entry => formatCompletionEntry(entry, {
    display,
    surface: "renderer",
    expanded,
    theme,
  }));
  if (expanded) {
    lines.push("");
    lines.push(RESULTS_INSTRUCTION);
  }
  return [header, ...lines].join("\n");
}

function formatNotificationContent(entries: readonly CompletionNotification[], display: SubagentDisplaySettings): string {
  const visible = entries.slice(0, MAX_LISTED_COMPLETIONS);
  const overflow = entries.length - visible.length;
  const header = formatCompletionHeader(entries.length, true);
  const lines = visible.map(entry => formatCompletionEntry(entry, {
    display,
    surface: "notification",
    expanded: true,
  }));
  if (overflow > 0) lines.push(`- ... and ${overflow} more`);
  lines.push("");
  lines.push(RESULTS_INSTRUCTION);
  return [header, ...lines].join("\n");
}

function copyCompletionNotification(entry: CompletionNotification): CompletionNotification {
  return {
    runId: entry.runId,
    conversationId: entry.conversationId,
    agent: entry.agent,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    status: entry.status,
    elapsedMs: entry.elapsedMs,
  };
}

function formatCompletionHeader(count: number, includeSinceLastNotification: boolean): string {
  return `${count} subagent${count === 1 ? "" : "s"} completed${includeSinceLastNotification ? " since the last notification:" : ""}`;
}

interface CompletionEntryFormatOptions {
  display: SubagentDisplaySettings;
  surface: EntrySurface;
  expanded: boolean;
  theme?: Pick<Theme, "fg">;
}

function formatCompletionEntry(entry: CompletionNotification, options: CompletionEntryFormatOptions): string {
  const labelPart = entry.label !== undefined
    ? ` (${formatCompletionLabel(entry.label, options.display.toolCallLabelMaxLength, options.surface)})`
    : "";
  const status = options.surface === "renderer"
    ? colorCompletionStatus(entry.status, options.theme)
    : entry.status;
  const identityPart = options.expanded
    ? ` · runId ${entry.runId} · conversationId ${entry.conversationId}`
    : "";
  return `- ${entry.agent}${labelPart} · ${status} · ${formatElapsed(entry.elapsedMs)}${identityPart}`;
}

/** Keeps producer and renderer truncation rules distinct while giving them one semantic owner. */
function formatCompletionLabel(value: string, limit: number, surface: EntrySurface): string {
  if (surface === "notification") return truncateNotificationLabel(value, limit);
  return compactRendererLabel(value, limit);
}

function truncateNotificationLabel(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function compactRendererLabel(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function colorCompletionStatus(status: AgentRunStatus, theme: Pick<Theme, "fg"> | undefined): string {
  const color = statusColor(status);
  return typeof theme?.fg === "function" ? theme.fg(color, status) : status;
}

/** Uses the completion renderer palette for every current terminal status. */
function statusColor(status: AgentRunStatus): ThemeColor {
  if (status === "completed") return "success";
  if (status === "error") return "error";
  if (status === "aborted" || status === "interrupted") return "warning";
  return "dim";
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.floor(seconds - minutes * 60);
  return `${minutes}m${remSeconds.toString().padStart(2, "0")}s`;
}
