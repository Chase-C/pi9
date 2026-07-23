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

export interface JoinActivityRenderItem {
  toolCallId?: string;
  tool: string;
  summary?: string;
}

/** A join invocation, retained in invocation order (including repeated targets). */
export interface JoinInvocationRenderItem {
  status: RunStatus;
  targets: JoinTargetRenderItem[];
  error?: string;
  toolCallId?: string;
}

/** A joined descendant. Deliberately has no output field: descendant answers are not UI data. */
export interface JoinTargetRenderItem {
  /** Missing when a failed join named a well-formed run ID unknown to the runtime. */
  conversationId?: ConversationId;
  runId: RunId;
  agent?: string;
  label?: string;
  status: RunStatus;
  activity?: JoinActivityRenderItem[];
  joins?: JoinInvocationRenderItem[];
  background?: JoinBackgroundOwnerRenderItem[];
  error?: string;
}

export interface JoinBackgroundRenderItem {
  conversationId: ConversationId;
  runId: RunId;
  agent?: string;
  label?: string;
  status: RunStatus;
  detachedAtFinal?: boolean;
}

export interface JoinBackgroundOwnerRenderItem {
  ownerRunId: RunId;
  ownerLabel?: string;
  entries: JoinBackgroundRenderItem[];
}

export interface JoinedRunRenderItem {
  conversationId: ConversationId;
  runId: RunId;
  agent?: string;
  label?: string;
  kind?: RunKind;
  prompt?: string;
  status: RunStatus;
  output?: string;
  error?: string;
  activity?: JoinActivityRenderItem[];
  joins?: JoinInvocationRenderItem[];
  background?: JoinBackgroundOwnerRenderItem[];
  /** IDs of represented subagent join calls; matching activity is omitted. */
  joinToolCallIds?: string[];
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
    case "join":
      return joinLines(details.runs, false, partial, theme);
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
      return joinLines(details.runs, true, false, theme);
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

function joinLines(runs: readonly JoinedRunRenderItem[], expanded: boolean, partial: boolean, theme?: ThemeLike): string[] {
  if (runs.length === 0) return [success(theme, "No runs joined")];
  return blocks(runs, (run, index) => renderJoinRoot(run, index, expanded, partial, theme));
}

function renderJoinRoot(run: JoinedRunRenderItem, index: number, expanded: boolean, partial: boolean, theme?: ThemeLike): string[] {
  const terminal = isTerminal(run.status);
  const failed = terminal && run.status !== "completed";
  const label = run.label || run.agent || run.runId || `run ${index + 1}`;
  const meta = [run.agent, run.kind].filter(Boolean).join(" · ");
  const lines = [
    `${statusMarker(theme, run.status)} ${paint(theme, "text", label)}${meta ? ` ${paint(theme, "muted", `· ${meta}`)}` : ""} ${paint(theme, "muted", "·")} ${statusText(theme, run.status)}`,
  ];
  const message = run.output ?? run.error;
  if (terminal && !expanded) {
    if (message) lines.push(`  ${paint(theme, failed ? "error" : "dim", truncate(message, 320))}`);
    return lines;
  }

  if (expanded) {
    if (run.prompt) lines.push(`  ${paint(theme, "dim", run.prompt)}`);
    lines.push(`  ${identity(theme, run.conversationId, run.runId)}`);
  } else if (partial && !run.activity?.length && !run.joins?.length) {
    lines.push(`  ${paint(theme, "dim", "waiting for result")}`);
  }

  lines.push(...renderJoinNode(run.activity, run.joins, run.background, "  ", expanded, theme));
  if (terminal && message) lines.push(`  ${paint(theme, failed ? "error" : "dim", truncate(message, 1200))}`);
  return lines;
}

function renderJoinNode(
  activity: readonly JoinActivityRenderItem[] | undefined,
  joins: readonly JoinInvocationRenderItem[] | undefined,
  background: readonly JoinBackgroundOwnerRenderItem[] | undefined,
  indent: string,
  expanded: boolean,
  theme?: ThemeLike,
): string[] {
  const groups = joins ?? [];
  const active = groups.filter(group => !isTerminal(group.status));
  const lines: string[] = [];

  if (active.length > 0) {
    for (const group of groups) {
      lines.push(...(isTerminal(group.status)
        ? renderTerminalJoin(group, indent, expanded, theme)
        : renderActiveJoin(group, activity?.length ?? 0, indent, expanded, theme)));
    }
  } else {
    const omitted = new Set(groups.flatMap(group => group.toolCallId ? [group.toolCallId] : []));
    lines.push(...renderActivity(activity, omitted, indent, theme));
    for (const group of groups) lines.push(...renderTerminalJoin(group, indent, expanded, theme));
  }

  for (const owner of background ?? []) lines.push(...renderBackground(owner, expanded, theme, indent));
  return lines;
}

function renderActivity(activity: readonly JoinActivityRenderItem[] | undefined, omitted: ReadonlySet<string>, indent: string, theme?: ThemeLike): string[] {
  const all = (activity ?? []).filter(item => !item.toolCallId || !omitted.has(item.toolCallId));
  const recent = all.slice(-3).reverse();
  const lines = recent.map(item => {
    const summary = item.summary ? `(${truncate(item.summary, 100)})` : "";
    return `${indent}${paint(theme, "muted", `${item.tool}${summary}`)}`;
  });
  const additional = all.length - recent.length;
  if (additional > 0) lines.push(`${indent}${paint(theme, "muted", `+${additional} tool calls`)}`);
  return lines;
}

function renderActiveJoin(group: JoinInvocationRenderItem, totalTools: number, indent: string, expanded: boolean, theme?: ThemeLike): string[] {
  const total = count(group.targets.length, "run");
  const toolCount = totalTools > 0 ? ` · ${count(totalTools, "total tool call")}` : "";
  return [
    `${indent}${paint(theme, "muted", `subagent join(${total})${toolCount}`)}`,
    ...renderJoinTargets(group.targets, indent, expanded, theme),
  ];
}

function renderTerminalJoin(group: JoinInvocationRenderItem, indent: string, expanded: boolean, theme?: ThemeLike): string[] {
  const failed = group.status !== "completed";
  const labels = group.targets.map(target => target.label || target.agent || target.runId);
  const summary = failed
    ? `${group.status === "interrupted" ? "join interrupted" : "join failed"}${group.error ? ` · ${group.error}` : ""}`
    : `joined ${group.targets.length}${labels.length ? ` · ${labels.join(", ")}` : ""}`;
  const lines = [`${indent}${paint(theme, failed ? "error" : "muted", `${failed ? "×" : "✓"} ${summary}`)}`];
  if (expanded) lines.push(...renderJoinTargets(group.targets, indent, true, theme));
  return lines;
}

function renderJoinTargets(targets: readonly JoinTargetRenderItem[], indent: string, expanded: boolean, theme?: ThemeLike): string[] {
  return targets.flatMap((target, index) => {
    const last = index === targets.length - 1;
    const connector = last ? "╰─" : "├─";
    const label = target.label || target.agent || target.runId;
    const agent = target.agent && target.agent !== label ? ` · ${target.agent}` : "";
    const lines = [
      `${indent}${paint(theme, "muted", connector)} ${statusMarker(theme, target.status)} ${paint(theme, "text", label)}${paint(theme, "muted", agent)} ${paint(theme, "muted", `· ${target.status}`)}`,
    ];
    const childIndent = `${indent}${last ? "   " : "│  "}  `;
    if (!isTerminal(target.status) || expanded) {
      lines.push(...renderJoinNode(target.activity, target.joins, target.background, childIndent, expanded, theme));
    }
    if (isTerminal(target.status) && target.error) lines.push(`${childIndent}${paint(theme, "error", target.error)}`);
    return lines;
  });
}

function renderBackground(owner: JoinBackgroundOwnerRenderItem, expanded: boolean, theme?: ThemeLike, indent = "  "): string[] {
  const active = owner.entries.filter(entry => !isTerminal(entry.status)).length;
  const completed = owner.entries.length - active;
  const counts = [active ? `${active} active` : "", completed ? `${completed} completed` : ""].filter(Boolean).join(" · ");
  const lines = [`${indent}${paint(theme, "muted", `background${counts ? ` · ${counts}` : ""}`)}`];
  if (expanded) for (const entry of owner.entries) {
    const label = entry.label || entry.agent || entry.runId;
    const detached = entry.detachedAtFinal ? paint(theme, "warning", " · detached at final") : "";
    lines.push(`${indent}  ${paint(theme, "muted", label)} · ${statusText(theme, entry.status)} · ${identity(theme, entry.conversationId, entry.runId)}${detached}`);
  }
  return lines;
}

function truncate(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
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

function statusMarker(theme: ThemeLike | undefined, status: RunStatus): string {
  if (status === "completed") return paint(theme, "success", "✓");
  if (status === "running") return paint(theme, "warning", "●");
  if (status === "queued") return paint(theme, "warning", "…");
  return paint(theme, "error", "×");
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
