import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../config/settings.js";
import { compact } from "./view-helpers.js";

export interface BackgroundCompletionMessageEntry {
  sessionId: string;
  agent: string;
  label?: string;
  status: string;
  elapsedMs: number;
}

interface BackgroundCompletionMessage {
  content?: unknown;
  details?: unknown;
}

export function formatBackgroundCompletionMessage(
  message: BackgroundCompletionMessage,
  expanded: boolean,
  theme: Pick<Theme, "fg"> | undefined,
  display: SubagentDisplaySettings = DEFAULT_SUBAGENT_SETTINGS.display,
): string {
  const completions = readBackgroundCompletions(message.details);
  if (completions.length === 0) return typeof message.content === "string" ? message.content : "";

  const header = `${completions.length} background subagent${completions.length === 1 ? "" : "s"} completed${expanded ? " since the last notification:" : ""}`;
  const lines = completions.map(entry => formatBackgroundCompletionEntry(entry, expanded, theme, display));
  if (expanded) {
    lines.push("");
    lines.push("Call subagent results with these sessionIds to retrieve output.");
  }
  return [header, ...lines].join("\n");
}

export function readBackgroundCompletions(details: unknown): BackgroundCompletionMessageEntry[] {
  if (!details || typeof details !== "object") return [];
  const completions = (details as { completions?: unknown }).completions;
  if (!Array.isArray(completions)) return [];
  return completions.filter(isBackgroundCompletionMessageEntry);
}

function isBackgroundCompletionMessageEntry(value: unknown): value is BackgroundCompletionMessageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sessionId === "string"
    && typeof entry.agent === "string"
    && (entry.label === undefined || typeof entry.label === "string")
    && typeof entry.status === "string"
    && typeof entry.elapsedMs === "number";
}

function formatBackgroundCompletionEntry(
  entry: BackgroundCompletionMessageEntry,
  expanded: boolean,
  theme: Pick<Theme, "fg"> | undefined,
  display: SubagentDisplaySettings,
): string {
  const labelPart = entry.label !== undefined ? ` (${compact(entry.label, display.toolCallLabelMaxLength)})` : "";
  const status = colorCompletionStatus(entry.status, theme);
  const sessionPart = expanded ? ` · sessionId ${entry.sessionId}` : "";
  return `- ${entry.agent}${labelPart} · ${status} · ${formatBackgroundElapsed(entry.elapsedMs)}${sessionPart}`;
}

function colorCompletionStatus(status: string, theme: Pick<Theme, "fg"> | undefined): string {
  const color = statusColor(status);
  return typeof theme?.fg === "function" ? theme.fg(color, status) : status;
}

function statusColor(status: string): ThemeColor {
  if (status === "completed") return "success";
  if (status === "error") return "error";
  if (status === "aborted" || status === "interrupted") return "warning";
  return "dim";
}

function formatBackgroundElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.floor(seconds - minutes * 60);
  return `${minutes}m${remSeconds.toString().padStart(2, "0")}s`;
}
