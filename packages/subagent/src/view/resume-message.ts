import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../config/settings.js";
import { compact } from "./view-helpers.js";

export interface SubagentResumeMessageDetails {
  sessionId: string;
  agent: string;
  status: string;
  promptPreview: string;
  outputSnippet?: string;
  errorSnippet?: string;
  result?: unknown;
}

export interface SubagentResumeMessage {
  customType: "subagent-resume";
  content: string;
  display: true;
  details: SubagentResumeMessageDetails;
}

export function createSubagentResumeMessage(
  result: {
    agent: string;
    prompt: string;
    status: string;
    output?: string;
    error?: string;
    sessionId?: string;
  },
  display: SubagentDisplaySettings = DEFAULT_SUBAGENT_SETTINGS.display,
): SubagentResumeMessage {
  const promptPreview = compact(result.prompt, display.promptPreviewLength);
  const outputSnippet = result.output ? compact(result.output, display.outputSnippetLength) : undefined;
  const errorSnippet = result.error ? compact(result.error, display.outputSnippetLength) : undefined;
  const sessionId = result.sessionId ?? "unknown";
  const details: SubagentResumeMessageDetails = {
    sessionId,
    agent: result.agent,
    status: result.status,
    promptPreview,
    outputSnippet,
    errorSnippet,
    result,
  };

  return {
    customType: "subagent-resume",
    display: true,
    content: formatSubagentResumeMessageContent(details, display),
    details,
  };
}

export function formatSubagentResumeMessageContent(
  details: SubagentResumeMessageDetails,
  display: SubagentDisplaySettings = DEFAULT_SUBAGENT_SETTINGS.display,
): string {
  const title = details.status === "completed" ? "Subagent resume completed" : `Subagent resume ${details.status}`;
  const parts = [
    title,
    `agent: ${details.agent}`,
    `session: ${details.sessionId}`,
    `prompt: ${details.promptPreview}`,
  ];
  if (details.outputSnippet) parts.push(`output: ${compact(details.outputSnippet, display.resumeMessageSnippetLength)}`);
  if (details.errorSnippet) parts.push(`error: ${compact(details.errorSnippet, display.resumeMessageSnippetLength)}`);
  return parts.join(" · ");
}

export function formatSubagentResumeMessageRender(
  details: SubagentResumeMessageDetails,
  expanded: boolean,
  theme: Pick<Theme, "fg"> | undefined,
  display: SubagentDisplaySettings = DEFAULT_SUBAGENT_SETTINGS.display,
): string {
  const title = details.status === "completed" ? "Subagent resume completed" : "Subagent resume finished";
  const status = colorResumeStatus(details.status, theme);
  if (!expanded) {
    const parts = [
      title,
      details.agent,
      status,
      `session ${details.sessionId}`,
      `prompt: ${details.promptPreview}`,
    ];
    if (details.outputSnippet) parts.push(`output: ${compact(details.outputSnippet, display.resumeMessageSnippetLength)}`);
    if (details.errorSnippet) parts.push(`error: ${compact(details.errorSnippet, display.resumeMessageSnippetLength)}`);
    return parts.join(" · ");
  }

  const lines = [
    title,
    `agent: ${details.agent}`,
    `status: ${status}`,
    `session: ${details.sessionId}`,
    `prompt: ${details.promptPreview}`,
  ];
  if (details.outputSnippet) lines.push(`output: ${compact(details.outputSnippet, display.resumeMessageSnippetLength)}`);
  if (details.errorSnippet) lines.push(`error: ${compact(details.errorSnippet, display.resumeMessageSnippetLength)}`);
  return lines.join("\n");
}

function colorResumeStatus(status: string, theme: Pick<Theme, "fg"> | undefined): string {
  const color = resumeStatusColor(status);
  return typeof theme?.fg === "function" ? theme.fg(color, status) : status;
}

function resumeStatusColor(status: string): ThemeColor {
  if (status === "completed") return "success";
  if (status === "error") return "error";
  if (status === "aborted" || status === "interrupted") return "warning";
  return "dim";
}
