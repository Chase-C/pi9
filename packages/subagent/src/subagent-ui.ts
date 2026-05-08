import type { Usage } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

import type { Agent, AgentStatus } from "./agent.js";
import type { AgentConfig } from "./agent-config.js";
import type { AgentRegistry } from "./agent-registry.js";

const PROMPT_PREVIEW_LENGTH = 120;
const MESSAGE_SNIPPET_LENGTH = 200;
const OUTPUT_SNIPPET_LENGTH = 200;
const RESUME_MESSAGE_SNIPPET_LENGTH = 80;

interface AgentRow {
  id: string;
  groupId: string;
  agent: string;
  status: string;
  resumable: boolean;
  promptPreview: string;
  messageSnippet?: string;
  outputSnippet?: string;
  errorSnippet?: string;
  activeTool?: string;
  turns: number;
  toolUses: number;
  compactions: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  source?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  usage?: Usage;
  inputIndex?: number;
}

interface AgentRowGroup {
  id: string;
  createdAt: number;
  statusCounts: Record<string, number>;
  sessions: AgentRow[];
  isError: boolean;
}

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

export function serializeAgent(agent: Agent, inputIndex?: number): AgentRow {
  const status = agent.status;
  const row: AgentRow = {
    id: agent.id,
    groupId: agent.groupId,
    agent: agent.options.agent,
    status: effectiveStatus(status),
    resumable: isResumable(agent),
    promptPreview: compact(agent.options.prompt, PROMPT_PREVIEW_LENGTH),
    messageSnippet: agent.message ? compact(agent.message, MESSAGE_SNIPPET_LENGTH) : undefined,
    activeTool: agent.tool,
    turns: agent.turns,
    toolUses: agent.toolUses,
    compactions: agent.compactions,
    createdAt: agent.createdAt,
    startedAt: getStartedAt(status),
    completedAt: getCompletedAt(status),
    outputSnippet: getOutputSnippet(status),
    errorSnippet: getErrorSnippet(status),
    source: agent.config.source,
    model: agent.options.model ?? agent.config.model,
    thinking: agent.options.thinking ?? agent.config.thinking,
    tools: agent.config.tools,
    usage: agent.totalUsage,
    inputIndex,
  };
  return row;
}

export function serializeUnknownAgentError(
  id: string,
  groupId: string,
  task: { agent: string; prompt: string; model?: string },
  error: string,
  createdAt: number,
  inputIndex?: number,
): AgentRow {
  return {
    id,
    groupId,
    agent: task.agent,
    status: "error",
    resumable: false,
    promptPreview: compact(task.prompt, PROMPT_PREVIEW_LENGTH),
    turns: 0,
    toolUses: 0,
    compactions: 0,
    createdAt,
    completedAt: createdAt,
    model: task.model,
    inputIndex,
    errorSnippet: compact(error, OUTPUT_SNIPPET_LENGTH),
  };
}

export function serializeGroup(
  id: string,
  createdAt: number,
  sessions: AgentRow[],
): AgentRowGroup {
  const statusCounts: Record<string, number> = {};
  for (const session of sessions) {
    statusCounts[session.status] = (statusCounts[session.status] ?? 0) + 1;
  }

  return {
    id,
    createdAt,
    statusCounts,
    sessions,
    isError: sessions.some(session => !isActiveStatusKind(session.status) && session.status !== "completed"),
  };
}

export function serializeAgentConfig(config: AgentConfig) {
  return {
    name: config.name,
    description: config.description,
    source: config.source,
    model: config.model,
    thinking: config.thinking,
    tools: config.tools,
    resumable: config.resumable,
    sourcePath: config.sourcePath,
  };
}

export function activeOrRetainedAgents(agents: Agent[]): Agent[] {
  return agents.filter(a => isActiveStatusKind(a.status.kind) || isResumable(a));
}

export function canResumeSubagentSession(agent: Agent): boolean {
  return isResumable(agent) && agent.status.kind === "done" && agent.status.result.status === "completed";
}

export function canClearSubagentSession(agent: Agent): boolean {
  return isResumable(agent) && !isActiveStatusKind(agent.status.kind);
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

export function formatSubagentSessionSummary(agent: Agent): string {
  const badges = [
    isResumable(agent) ? "resumable" : undefined,
    `session:${agent.id}`,
  ].filter(Boolean);
  return [agent.options.agent, effectiveStatus(agent.status), ...badges, `"${compact(agent.options.prompt, PROMPT_PREVIEW_LENGTH)}"`].join(" · ");
}

export function formatSubagentSessionInspect(agent: Agent, now = Date.now()): string[] {
  const status = agent.status;
  const startedAt = getStartedAt(status);
  const completedAt = getCompletedAt(status);
  const elapsed = formatElapsed(startedAt ?? agent.createdAt, completedAt ?? now);
  const resumable = isResumable(agent);
  const model = agent.options.model ?? agent.config.model;
  const thinking = agent.options.thinking ?? agent.config.thinking;

  const lines = [
    `Session ${agent.id}`,
    `Status: ${effectiveStatus(status)}${resumable ? " · resumable" : ""}`,
    `Agent: ${agent.options.agent} (${agent.config.source})`,
  ];

  if (model || thinking) {
    lines.push(`Model: ${model ?? "default"}${thinking ? ` · thinking:${thinking}` : ""}`);
  }
  lines.push(`Tools: ${agent.config.tools?.length ? agent.config.tools.join(", ") : "default"}`);
  lines.push(`Prompt: ${compact(agent.options.prompt, PROMPT_PREVIEW_LENGTH)}`);
  if (agent.tool) lines.push(`Active tool: ${agent.tool}`);
  lines.push(`Progress: ${agent.turns} turn${agent.turns === 1 ? "" : "s"} · ${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"} · ${agent.compactions} compaction${agent.compactions === 1 ? "" : "s"}`);
  lines.push(`Usage: ${formatUsage(agent.totalUsage)}`);
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

export function formatSubagentSessionLine(agent: Agent, now = Date.now()): string {
  const status = agent.status;
  const startedAt = getStartedAt(status);
  const completedAt = getCompletedAt(status);
  const elapsed = formatElapsed(startedAt ?? agent.createdAt, completedAt ?? now);
  const effective = effectiveStatus(status);
  const parts = [
    agent.options.agent,
    effective,
    `${agent.turns} turn${agent.turns === 1 ? "" : "s"}`,
    elapsed,
  ];

  if (agent.tool) parts.push(`tool:${agent.tool}`);
  if (agent.message) parts.push(`"${compact(agent.message, MESSAGE_SNIPPET_LENGTH)}"`);

  if (!isActiveStatusKind(effective)) {
    if (effective === "completed") {
      parts.push(`outcome:completed`);
    } else {
      const errorSnippet = getErrorSnippet(status);
      parts.push(`outcome:${effective}:${errorSnippet ?? effective}`);
    }
  }

  return parts.join(" · ");
}

export function formatWidgetLines(agents: Agent[], now = Date.now()): string[] {
  const visible = activeOrRetainedAgents(agents);
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

  if (row.activeTool) parts.push(`tool:${row.activeTool}`);
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

export function listAgentDefinitions(agentRegistry: AgentRegistry) {
  return Array.from(agentRegistry.agents.values()).map(serializeAgentConfig);
}

function isResumable(agent: Agent): boolean {
  const status = agent.status;
  if (!agent.config.resumable) return false;
  if (status.kind === "queued" || status.kind === "running") return true;
  return Boolean(status.session);
}

function effectiveStatus(status: AgentStatus): string {
  return status.kind === "done" ? status.result.status : status.kind;
}

function getStartedAt(status: AgentStatus): number | undefined {
  if (status.kind === "running") return status.startedAt;
  if (status.kind === "done") return status.startedAt;
  return undefined;
}

function getCompletedAt(status: AgentStatus): number | undefined {
  return status.kind === "done" ? status.completedAt : undefined;
}

function getOutputSnippet(status: AgentStatus): string | undefined {
  if (status.kind === "done" && status.result.status === "completed" && status.result.output) {
    return compact(status.result.output, OUTPUT_SNIPPET_LENGTH);
  }
  return undefined;
}

function getErrorSnippet(status: AgentStatus): string | undefined {
  if (status.kind !== "done") return undefined;
  if (status.result.status === "completed") return undefined;
  return compact(status.result.error ?? status.result.status, OUTPUT_SNIPPET_LENGTH);
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

function isActiveStatusKind(status: string): boolean {
  return status === "queued" || status === "running";
}

function compact(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
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
