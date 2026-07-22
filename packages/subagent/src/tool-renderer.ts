import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AgentSource } from "./agents.js";
import type { RunKind } from "./conversation.js";
import type { ConversationId, RunId } from "./identifiers.js";
import type { RunStatus, SubagentAction } from "./schema.js";

type ThemeLike = Partial<Pick<Theme, "fg" | "bold">>;
type ThemeColor = Parameters<Theme["fg"]>[0];

export interface AgentRenderItem {
  name: string;
  description: string;
  source: AgentSource;
  model?: string;
  thinking?: string;
  tools?: readonly string[];
}

export interface RunRenderItem {
  inputIndex: number;
  kind?: RunKind;
  agent?: string;
  label?: string;
  prompt?: string;
  conversationId?: ConversationId;
  runId?: RunId;
  error?: string;
}

export interface ListedRunRenderItem {
  conversationId: ConversationId;
  runId: RunId;
  agent: string;
  label?: string;
  kind: RunKind;
  status: RunStatus;
}

export interface JoinedRunRenderItem {
  conversationId: ConversationId;
  runId: RunId;
  agent?: string;
  label?: string;
  status: RunStatus;
  output?: string;
  error?: string;
}

export type SubagentToolDetails =
  | { action: "agents"; agents: AgentRenderItem[] }
  | { action: "list"; runs: ListedRunRenderItem[] }
  | { action: "run"; tasks: RunRenderItem[] }
  | { action: "join"; runs: JoinedRunRenderItem[] }
  | {
      action: "remove";
      removed: number;
      aborted: number;
      conversationIds: ConversationId[];
      errors: Array<{ conversationId: string; error: string }>;
    }
  | { action: "error"; requestedAction?: SubagentAction; message: string };

export function renderSubagentCall(args: unknown, theme?: ThemeLike): Text {
  const input = asRecord(args);
  const action = typeof input?.action === "string" ? input.action : "pending";
  const suffix = callSuffix(action, input);
  const title = `${paint(theme, "toolTitle", bold(theme, "subagent"))} ${paint(theme, "toolTitle", action)}`;
  return new Text(`${title}${suffix ? paint(theme, "dim", `  ${suffix}`) : ""}`, 0, 0);
}

export function renderSubagentResult(
  result: { details?: SubagentToolDetails; content?: readonly { type?: string; text?: string }[] },
  options: { expanded?: boolean; isPartial?: boolean } = {},
  theme?: ThemeLike,
): Text {
  const details = result.details;
  if (!details) return new Text(fallbackText(result), 0, 0);
  if (details.action === "error") return new Text(paint(theme, "error", details.message), 0, 0);

  const lines = options.expanded
    ? expandedLines(details, theme)
    : collapsedLines(details, options.isPartial === true, theme);
  return new Text(lines.join("\n"), 0, 0);
}

function collapsedLines(details: Exclude<SubagentToolDetails, { action: "error" }>, partial: boolean, theme?: ThemeLike): string[] {
  switch (details.action) {
    case "agents": {
      if (details.agents.length === 0) return [success(theme, "No agents available")];
      return [
        success(theme, `Found ${count(details.agents.length, "available agent")}`),
        secondary(details.agents.map(agent => agent.name), theme),
      ];
    }
    case "list": {
      if (details.runs.length === 0) return [success(theme, "No runs found")];
      return [
        success(theme, `Found ${count(details.runs.length, "run")}${statusSummary(details.runs.map(run => run.status), theme)}`),
        secondary(details.runs.map(runLabel), theme),
      ];
    }
    case "run": {
      const accepted = details.tasks.filter(task => task.runId);
      const rejected = details.tasks.length - accepted.length;
      const spawned = accepted.filter(task => task.kind === "spawn").length;
      const resumed = accepted.filter(task => task.kind === "resume").length;
      const outcome = runOutcomeSummary(spawned, resumed, rejected, theme);
      const labels = details.tasks.map((task, index) => taskLabel(task, index));
      return labels.length ? [success(theme, outcome), secondary(labels, theme)] : [success(theme, outcome)];
    }
    case "join": {
      const terminal = details.runs.filter(run => isTerminal(run.status)).length;
      const lead = partial && terminal < details.runs.length
        ? `Waiting for ${count(details.runs.length, "run")}`
        : `Joined ${count(details.runs.length, "run")}`;
      const labels = details.runs.map((run, index) => run.label || run.agent || run.runId || `run ${index + 1}`);
      return [
        success(theme, `${lead}${statusSummary(details.runs.map(run => run.status), theme)}`),
        secondary(labels, theme),
      ];
    }
    case "remove": {
      const summary = [`Removed ${count(details.removed, "conversation")}`];
      if (details.aborted) summary.push(`${count(details.aborted, "active run")} aborted`);
      if (details.errors.length) summary.push(count(details.errors.length, "error"));
      const lines = [success(theme, summary.join(paint(theme, "muted", " · ")))];
      if (details.conversationIds.length) lines.push(secondary(details.conversationIds, theme));
      return lines;
    }
  }
}

function expandedLines(details: Exclude<SubagentToolDetails, { action: "error" }>, theme?: ThemeLike): string[] {
  switch (details.action) {
    case "agents":
      if (details.agents.length === 0) return [success(theme, "No agents available")];
      return blocks(details.agents, (agent) => [
        `${arrow(theme)} ${paint(theme, "text", agent.name)} ${paint(theme, "muted", `· ${agent.source}`)}`,
        `  ${paint(theme, "dim", agent.description)}`,
        `  ${tag(theme, "model", agent.model ?? "inherit")} ${paint(theme, "muted", "·")} ${tag(theme, "thinking", agent.thinking ?? "inherit")}`,
        `  ${tag(theme, "tools", agent.tools?.join(", ") || "default toolset")}`,
      ]);
    case "list":
      if (details.runs.length === 0) return [success(theme, "No runs found")];
      return blocks(details.runs, run => [
        `${arrow(theme)} ${paint(theme, "text", runLabel(run))} ${paint(theme, "muted", `· ${run.agent} · ${run.kind}`)}`,
        `  ${statusText(theme, run.status)} ${paint(theme, "muted", "·")} ${identity(theme, run.conversationId, run.runId)}`,
      ]);
    case "run":
      return blocks(details.tasks, (task, index) => {
        const label = taskLabel(task, index);
        const meta = [task.agent, task.kind].filter(Boolean).join(" · ");
        const lines = [`${task.error ? errorMarker(theme) : arrow(theme)} ${paint(theme, "text", label)}${meta ? ` ${paint(theme, "muted", `· ${meta}`)}` : ""}`];
        if (task.prompt) lines.push(`  ${paint(theme, "dim", task.prompt)}`);
        if (task.error) lines.push(`  ${paint(theme, "error", task.error)}`);
        else if (task.conversationId && task.runId) lines.push(`  ${paint(theme, "success", "started")} ${paint(theme, "muted", "·")} ${identity(theme, task.conversationId, task.runId)}`);
        return lines;
      });
    case "join":
      return blocks(details.runs, (run, index) => {
        const failed = run.status === "error" || run.status === "aborted" || run.status === "interrupted" || run.status === "skipped";
        const label = run.label || run.agent || run.runId || `run ${index + 1}`;
        const lines = [`${failed ? errorMarker(theme) : arrow(theme)} ${paint(theme, "text", label)} ${paint(theme, "muted", "·")} ${statusText(theme, run.status)}`];
        const message = run.output ?? run.error;
        if (message) lines.push(`  ${paint(theme, failed ? "error" : "dim", message)}`);
        lines.push(`  ${identity(theme, run.conversationId, run.runId)}`);
        return lines;
      });
    case "remove": {
      const items = details.conversationIds.map(conversationId => [
        `${arrow(theme)} ${paint(theme, "text", conversationId)} ${paint(theme, "muted", "· removed")}`,
        `  ${tag(theme, "conversation", conversationId)}`,
      ]);
      for (const error of details.errors) {
        items.push([
          `${errorMarker(theme)} ${paint(theme, "text", error.conversationId)} ${paint(theme, "muted", "· not removed")}`,
          `  ${paint(theme, "error", error.error)}`,
        ]);
      }
      const lines = joinBlocks(items);
      if (details.aborted) {
        if (lines.length) lines.push("");
        lines.push(`  ${paint(theme, "warning", `${count(details.aborted, "active run")} aborted`)}`);
      }
      return lines.length ? lines : [success(theme, "No conversations removed")];
    }
  }
}

function callSuffix(action: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  if (action === "run") return arrayCount(input.tasks, "task");
  if (action === "join") return arrayCount(input.runIds, "run");
  if (action === "remove") return arrayCount(input.conversationIds, "conversation");
  return "";
}

function arrayCount(value: unknown, noun: string): string {
  return Array.isArray(value) && value.length ? count(value.length, noun) : "";
}

function runOutcomeSummary(spawned: number, resumed: number, rejected: number, theme?: ThemeLike): string {
  const parts: string[] = [];
  if (spawned) parts.push(`Started ${count(spawned, "new conversation")}`);
  if (resumed) parts.push(spawned ? `resumed ${resumed}` : `Resumed ${count(resumed, "conversation")}`);
  if (!spawned && !resumed) parts.push("No tasks started");
  let summary = parts.join(" and ");
  if (rejected) summary += paint(theme, "muted", ` · ${count(rejected, "rejected task")}`);
  return summary;
}

function statusSummary(statuses: readonly RunStatus[], theme?: ThemeLike): string {
  if (statuses.length === 0) return "";
  const order: readonly RunStatus[] = ["queued", "running", "completed", "error", "aborted", "interrupted", "skipped"];
  const parts = order.flatMap(status => {
    const total = statuses.filter(value => value === status).length;
    return total ? [`${total} ${status}`] : [];
  });
  return parts.length ? paint(theme, "muted", ` · ${parts.join(" · ")}`) : "";
}

function blocks<T>(items: readonly T[], render: (item: T, index: number) => string[]): string[] {
  return joinBlocks(items.map(render));
}

function joinBlocks(items: readonly string[][]): string[] {
  return items.flatMap((item, index) => index === items.length - 1 ? item : [...item, ""]);
}

function taskLabel(task: RunRenderItem, index: number): string {
  return task.label || task.agent || task.conversationId || `task ${index + 1}`;
}

function runLabel(run: { label?: string; agent: string }): string {
  return run.label || run.agent;
}

function identity(theme: ThemeLike | undefined, conversationId: string, runId: string): string {
  return `${tag(theme, "conversation", conversationId)} ${paint(theme, "muted", "·")} ${tag(theme, "run", runId)}`;
}

function tag(theme: ThemeLike | undefined, name: string, value: string): string {
  return `${paint(theme, "muted", name)} ${paint(theme, "accent", value)}`;
}

function statusText(theme: ThemeLike | undefined, status: RunStatus): string {
  const color: ThemeColor = status === "completed" ? "success"
    : status === "queued" || status === "running" ? "warning"
      : "error";
  return paint(theme, color, status);
}

function isTerminal(status: RunStatus): boolean {
  return status !== "queued" && status !== "running";
}

function arrow(theme?: ThemeLike): string {
  return paint(theme, "success", "→");
}

function errorMarker(theme?: ThemeLike): string {
  return paint(theme, "error", "×");
}

function success(theme: ThemeLike | undefined, text: string): string {
  return `${paint(theme, "success", "✓")} ${text}`;
}

function secondary(values: readonly string[], theme?: ThemeLike): string {
  return paint(theme, "muted", `  ${values.join(" · ")}`);
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function paint(theme: ThemeLike | undefined, color: ThemeColor, text: string): string {
  return theme?.fg ? theme.fg(color, text) : text;
}

function bold(theme: ThemeLike | undefined, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function fallbackText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return result.content?.find(part => part.type === "text")?.text || "Subagent action failed.";
}
