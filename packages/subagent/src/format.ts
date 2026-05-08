import type { Usage } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

import type { AgentView } from "./agent.js";
import type { AgentConfig } from "./agent-config.js";
import {
  AgentRow,
  AgentRowGroup,
  MESSAGE_SNIPPET_LENGTH,
  OUTPUT_SNIPPET_LENGTH,
  PROMPT_PREVIEW_LENGTH,
  canClearSubagentSession,
  canResumeSubagentSession,
  compact,
  effectiveStatus,
  getCompletedAt,
  getErrorSnippet,
  getOutputSnippet,
  getStartedAt,
  isActiveStatusKind,
  serializeAgent,
  serializeGroup,
} from "./serialize.js";

const RESUME_MESSAGE_SNIPPET_LENGTH = 80;

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

export function formatAgentConfigSummary(config: AgentConfig): string {
  const badges = [config.source, config.resumable ? "resumable" : undefined].filter(Boolean);
  return [config.name, ...badges, config.description].join(" · ");
}

export function formatAgentConfigInspect(config: AgentConfig): string[] {
  const lines = [
    `Name: ${config.name}`,
    `Description: ${config.description}`,
    `Source: ${config.source}`,
    `Model: ${config.model ?? "default"}`,
    `Thinking: ${config.thinking ?? "default"}`,
    `Tools: ${config.tools?.length ? config.tools.join(", ") : "default"}`,
    `Resumable: ${config.resumable}`,
  ];
  if (config.sourcePath) lines.push(`Path: ${config.sourcePath}`);
  return lines;
}

export function formatSubagentSessionSummary(agent: AgentView): string {
  const badges = [
    agent.resumable ? "resumable" : undefined,
    `session:${agent.id}`,
  ].filter(Boolean);
  return [agent.agentName, effectiveStatus(agent.status), ...badges, `"${compact(agent.prompt, PROMPT_PREVIEW_LENGTH)}"`].join(" · ");
}

export function formatSubagentSessionInspect(agent: AgentView, now = Date.now()): string[] {
  const status = agent.status;
  const startedAt = getStartedAt(status);
  const completedAt = getCompletedAt(status);
  const elapsed = formatElapsed(startedAt ?? agent.createdAt, completedAt ?? now);
  const resumable = agent.resumable;
  const model = agent.resolvedModel;
  const thinking = agent.resolvedThinking;

  const lines = [
    `Session ${agent.id}`,
    `Status: ${effectiveStatus(status)}${resumable ? " · resumable" : ""}`,
    `Agent: ${agent.agentName}${agent.source ? ` (${agent.source})` : ""}`,
  ];

  if (model || thinking) {
    lines.push(`Model: ${model ?? "default"}${thinking ? ` · thinking:${thinking}` : ""}`);
  }
  lines.push(`Tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}`);
  lines.push(`Prompt: ${compact(agent.prompt, PROMPT_PREVIEW_LENGTH)}`);
  const prompts = agent.prompts;
  if (prompts && prompts.length > 1) lines.push(`Prompts: ${prompts.length} sent · latest ${compact(prompts.at(-1)?.prompt ?? "", PROMPT_PREVIEW_LENGTH)}`);
  if (agent.activeTools?.length) {
    lines.push(`Active tool${agent.activeTools.length === 1 ? "" : "s"}: ${agent.activeTools.join(", ")}`);
  }
  lines.push(`Progress: ${agent.turns} turn${agent.turns === 1 ? "" : "s"} · ${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"} · ${agent.compactions} compaction${agent.compactions === 1 ? "" : "s"}`);
  if (agent.totalUsage) lines.push(`Usage: ${formatUsage(agent.totalUsage)}`);
  lines.push(`Timestamps: created ${formatTimestamp(agent.createdAt)}${startedAt ? ` · started ${formatTimestamp(startedAt)}` : ""}${completedAt ? ` · completed ${formatTimestamp(completedAt)}` : ""} · elapsed ${elapsed}`);

  const outputSnippet = getOutputSnippet(status);
  const errorSnippet = getErrorSnippet(status);
  if (outputSnippet) lines.push(`Output: ${outputSnippet}`);
  if (errorSnippet) lines.push(`Error: ${errorSnippet}`);
  if (agent.message) lines.push(`Message: ${compact(agent.message, MESSAGE_SNIPPET_LENGTH)}`);

  const actions = ["inspect"];
  if (canResumeSubagentSession(agent)) actions.push("resume");
  if (canClearSubagentSession(agent)) actions.push("clear");
  lines.push(`Actions: ${actions.join(", ")}`);
  return lines;
}

export function formatSubagentSessionLine(agent: AgentView, now = Date.now()): string {
  return formatRowSessionLine(serializeAgent(agent), now);
}

export function formatWidgetLines(agents: AgentView[], now = Date.now()): string[] {
  const visible = agents.filter(a => isActiveStatusKind(a.status.kind) || a.resumable);
  if (visible.length === 0) return [];
  if (visible.length === 1) return [formatSubagentSessionLine(visible[0], now)];

  const active = visible.filter(a => isActiveStatusKind(a.status.kind)).length;
  const retained = visible.length - active;
  return [`Subagents: ${active} active · ${retained} retained`];
}

export function formatSubagentToolLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
): string[] {
  const group = extractGroup(details);
  if (group) {
    if (!expanded) return [formatRowGroupLine(group)];
    return group.sessions.map(row => formatRowSessionLine(row, now));
  }

  const sessions = extractSessions(details);
  if (sessions.length === 0) return ["No subagent sessions."];

  if (!expanded && sessions.length > 1) {
    return [formatRowGroupLine(serializeGroup("subagent", Date.now(), sessions))];
  }

  return sessions.map(row => formatRowSessionLine(row, now));
}

export function createSubagentResumeMessage(result: {
  agent: string;
  prompt: string;
  status: string;
  output?: string;
  error?: string;
  sessionId?: string;
}): SubagentResumeMessage {
  const promptPreview = compact(result.prompt, PROMPT_PREVIEW_LENGTH);
  const outputSnippet = result.output ? compact(result.output, OUTPUT_SNIPPET_LENGTH) : undefined;
  const errorSnippet = result.error ? compact(result.error, OUTPUT_SNIPPET_LENGTH) : undefined;
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
    content: formatSubagentResumeMessageContent(details),
    details,
  };
}

export function formatSubagentResumeMessageContent(details: SubagentResumeMessageDetails): string {
  const title = details.status === "completed" ? "Subagent resume completed" : `Subagent resume ${details.status}`;
  const parts = [
    title,
    `agent: ${details.agent}`,
    `session: ${details.sessionId}`,
    `prompt: ${details.promptPreview}`,
  ];
  if (details.outputSnippet) parts.push(`output: ${compact(details.outputSnippet, RESUME_MESSAGE_SNIPPET_LENGTH)}`);
  if (details.errorSnippet) parts.push(`error: ${compact(details.errorSnippet, RESUME_MESSAGE_SNIPPET_LENGTH)}`);
  return parts.join(" · ");
}

export function createSubagentTextComponent(
  details: unknown,
  expanded: boolean,
  theme: any,
  now = Date.now(),
) {
  const lines = formatSubagentToolLines(details, expanded, now);
  const text = lines.map(line => colorLine(line, theme)).join("\n");
  return new Text(text, 0, 0);
}

function formatRowGroupLine(group: AgentRowGroup): string {
  const knownStatuses = ["queued", "running", "completed", "error", "interrupted", "skipped", "aborted"];
  const counts = knownStatuses
    .filter(status => group.statusCounts[status])
    .map(status => `${group.statusCounts[status]} ${status}`);
  const extraCounts = Object.keys(group.statusCounts)
    .filter(status => !knownStatuses.includes(status))
    .sort()
    .map(status => `${group.statusCounts[status]} ${status}`);
  const active = group.sessions.some(session => isActiveStatusKind(session.status));
  const outcome = group.isError ? "error" : active ? "running" : "completed";
  return [`${group.sessions.length} subagents`, ...counts, ...extraCounts, `outcome:${outcome}`].join(" · ");
}

function formatRowSessionLine(row: AgentRow, now: number): string {
  const elapsed = formatElapsed((row.startedAt ?? row.createdAt), row.completedAt ?? now);
  const parts = [
    row.agent,
    row.status,
    `${row.turns} turn${row.turns === 1 ? "" : "s"}`,
    elapsed,
  ];

  const activeTool = row.activeTools?.at(-1) ?? row.activeTool;
  if (activeTool) parts.push(`tool:${activeTool}`);
  if (row.messageSnippet) parts.push(`"${row.messageSnippet}"`);

  if (!isActiveStatusKind(row.status)) {
    if (row.status === "completed") {
      parts.push(`outcome:completed`);
    } else {
      parts.push(`outcome:${row.status}:${row.errorSnippet ?? row.status}`);
    }
  }

  return parts.join(" · ");
}

function extractGroup(details: unknown): AgentRowGroup | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as { group?: unknown };
  if (record.group && typeof record.group === "object") return record.group as AgentRowGroup;
  return undefined;
}

function extractSessions(details: unknown): AgentRow[] {
  if (!details || typeof details !== "object") return [];
  const record = details as { sessions?: unknown };
  if (Array.isArray(record.sessions)) return record.sessions as AgentRow[];
  return [];
}

function formatElapsed(from: number, to: number) {
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function formatTimestamp(value: number) {
  return new Date(value).toISOString();
}

function formatUsage(usage: Usage) {
  const tokens = `${usage.totalTokens} tokens`;
  const cost = usage.cost?.total ? ` · $${usage.cost.total.toFixed(4)}` : "";
  return `${tokens}${cost}`;
}

function colorLine(line: string, theme: any) {
  if (!theme?.fg) return line;
  if (line.includes("status:error") || line.includes("outcome:error")) return theme.fg("error", line);
  if (line.includes("status:aborted") || line.includes("outcome:aborted")) return theme.fg("warning", line);
  if (line.includes("status:interrupted") || line.includes("outcome:interrupted")) return theme.fg("warning", line);
  if (line.includes("status:skipped") || line.includes("outcome:skipped")) return theme.fg("warning", line);
  if (line.includes("completed") || line.includes("outcome:completed")) return theme.fg("success", line);
  if (line.includes("running")) return theme.fg("accent", line);
  return theme.fg("muted", line);
}
