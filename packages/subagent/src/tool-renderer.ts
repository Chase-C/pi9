import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { AgentSource } from "./agents.js";
import type { ConversationEffectiveConfig, ConversationRequestedOverrides, RunKind, RunPhase, SteerReceipt } from "./conversation.js";
import type { ConversationId, RunId } from "./identifiers.js";
import { formatElapsed, formatTokens } from "./run-format.js";
import type { DispatchTaskKind, RunStatus, SubagentAction } from "./schema.js";

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

export interface DispatchTaskRenderItem {
  inputIndex: number;
  kind?: DispatchTaskKind;
  agent?: string;
  label?: string;
  prompt?: string;
  conversationId?: ConversationId;
  runId?: RunId;
  steer?: SteerReceipt;
  error?: string;
}

export interface ListedRunRenderItem {
  runId: RunId;
  parentRunId?: RunId;
  rootRunId: RunId;
  depth: number;
  kind: RunKind;
  status: RunStatus;
  createdAt: number;
}

export interface ListedConversationRenderItem {
  conversationId: ConversationId;
  agent: string;
  label?: string;
  createdAt: number;
  canResume: boolean;
  runs: ListedRunRenderItem[];
}

export interface JoinActivityRenderItem {
  toolCallId?: string;
  tool: string;
  summary?: string;
}

export interface CancelledRunRenderItem {
  conversationId?: ConversationId;
  runId: string;
  status?: "aborted";
  error?: string;
}

export interface InspectedRunErrorRenderItem {
  inputIndex: number;
  runId: string;
  error: string;
}

export interface InspectedRunRenderItem {
  conversationId: ConversationId;
  runId: RunId;
  parentRunId?: RunId;
  rootRunId: RunId;
  depth: number;
  requestedOverrides?: ConversationRequestedOverrides;
  effectiveConfig?: ConversationEffectiveConfig;
  agent?: string;
  label?: string;
  status: RunStatus;
  phase?: RunPhase;
  elapsedMs: number;
  turns: number;
  compactions: number;
  messageSnippet?: string;
  errorSnippet?: string;
  recentTools: Array<JoinActivityRenderItem & { status: "running" | "completed" | "error" | "interrupted" }>;
  steers: readonly SteerReceipt[];
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
  elapsedMs?: number;
  turns?: number;
  tokens?: number;
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
  conversationId?: ConversationId;
  runId: string;
  agent?: string;
  label?: string;
  kind?: RunKind;
  prompt?: string;
  status: RunStatus;
  output?: string;
  error?: string;
  elapsedMs?: number;
  turns?: number;
  tokens?: number;
  activity?: JoinActivityRenderItem[];
  joins?: JoinInvocationRenderItem[];
  background?: JoinBackgroundOwnerRenderItem[];
  /** IDs of represented subagent join calls; matching activity is omitted. */
  joinToolCallIds?: string[];
}

export type SubagentToolDetails =
  | { action: "agents"; agents: AgentRenderItem[] }
  | { action: "list"; conversations: ListedConversationRenderItem[] }
  | { action: "spawn"; tasks: DispatchTaskRenderItem[] }
  | { action: "resume"; tasks: DispatchTaskRenderItem[] }
  | { action: "steer"; tasks: DispatchTaskRenderItem[] }
  | { action: "cancel"; runs: CancelledRunRenderItem[] }
  | { action: "inspect"; runs: Array<InspectedRunRenderItem | InspectedRunErrorRenderItem> }
  | { action: "join"; runs: JoinedRunRenderItem[] }
  | {
      action: "remove";
      removed: number;
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
): Component {
  const details = result.details;
  if (!details) return new Text(fallbackText(result), 0, 0);
  if (details.action === "error") return new Text(paint(theme, "error", details.message), 0, 0);

  const lines = options.expanded
    ? expandedLines(details, theme)
    : collapsedLines(details, options.isPartial === true, theme);
  return new IndentedText(lines);
}

class IndentedText implements Component {
  constructor(private readonly lines: readonly string[]) {}

  render(width: number): string[] {
    return this.lines.flatMap(line => {
      if (!line) return [""];
      const indent = line.match(/^ */)?.[0] ?? "";
      const indentWidth = visibleWidth(indent);
      const content = line.slice(indent.length);
      return wrapTextWithAnsi(content, Math.max(1, width - indentWidth))
        .map(wrapped => `${indent}${wrapped}`);
    });
  }

  invalidate(): void {}
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
      if (details.conversations.length === 0) return [success(theme, "No conversations found")];
      const runs = details.conversations.flatMap(conversation => conversation.runs);
      return [
        success(theme, `Found ${count(details.conversations.length, "conversation")} ${paint(theme, "muted", "·")} ${count(runs.length, "run")}${statusSummary(runs.map(run => run.status), theme)}`),
        secondary(details.conversations.map(conversationLabel), theme),
      ];
    }
    case "spawn":
    case "resume":
    case "steer": {
      const accepted = details.tasks.filter(task => task.runId);
      const rejected = details.tasks.length - accepted.length;
      const spawned = accepted.filter(task => task.kind === "spawn").length;
      const resumed = accepted.filter(task => task.kind === "resume").length;
      const steered = accepted.filter(task => task.kind === "steer").length;
      const outcome = dispatchOutcomeSummary(spawned, resumed, steered, rejected, theme);
      const labels = details.tasks.map((task, index) => taskLabel(task, index));
      return labels.length ? [success(theme, outcome), secondary(labels, theme)] : [success(theme, outcome)];
    }
    case "cancel": {
      const cancelled = details.runs.filter(run => run.status === "aborted").length;
      const errors = details.runs.length - cancelled;
      const summary = [`Cancelled ${count(cancelled, "run")}`];
      if (errors) summary.push(count(errors, "error"));
      return [success(theme, summary.join(paint(theme, "muted", " · "))), secondary(details.runs.map(run => run.runId), theme)];
    }
    case "inspect": {
      if (details.runs.length === 0) return [success(theme, "No runs inspected")];
      const inspected = details.runs.filter((run): run is InspectedRunRenderItem => !("error" in run));
      const errors = details.runs.length - inspected.length;
      const summary = inspected.length
        ? `Inspected ${count(inspected.length, "run")}${statusSummary(inspected.map(run => run.status), theme)}${errors ? `${paint(theme, "muted", " · ")}${count(errors, "error")}` : ""}`
        : `Inspected ${count(errors, "target")} ${paint(theme, "muted", "·")} ${count(errors, "error")}`;
      return [
        success(theme, summary),
        secondary(details.runs.map(run => "error" in run ? run.runId : run.label || run.agent || run.runId), theme),
      ];
    }
    case "join":
      return joinLines(details.runs, false, partial, theme);
    case "remove": {
      const summary = [`Removed ${count(details.removed, "conversation")}`];
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
      if (details.conversations.length === 0) return [success(theme, "No conversations found")];
      return blocks(details.conversations, conversation => {
        const lines = [
          `${arrow(theme)} ${paint(theme, "text", conversationLabel(conversation))} ${paint(theme, "muted", `· ${conversation.agent} · ${count(conversation.runs.length, "run")}${conversation.canResume ? " · resumable" : ""}`)}`,
          `  ${tag(theme, "conversation", conversation.conversationId)}`,
        ];
        for (const run of conversation.runs) {
          lines.push(`  ${statusMarker(theme, run.status)} ${paint(theme, "text", run.runId)} ${paint(theme, "muted", `· ${run.kind} · depth ${run.depth} ·`)} ${statusText(theme, run.status)}`);
        }
        return lines;
      });
    case "spawn":
    case "resume":
    case "steer":
      return blocks(details.tasks, (task, index) => {
        const label = taskLabel(task, index);
        const meta = [task.agent, task.kind].filter(Boolean).join(" · ");
        const lines = [`${task.error ? errorMarker(theme) : arrow(theme)} ${paint(theme, "text", label)}${meta ? ` ${paint(theme, "muted", `· ${meta}`)}` : ""}`];
        if (task.prompt) lines.push(`  ${paint(theme, "dim", task.prompt)}`);
        if (task.error) lines.push(`  ${paint(theme, "error", task.error)}`);
        else if (task.conversationId && task.runId) {
          const receipt = task.steer ? ` ${paint(theme, "muted", `· steer #${task.steer.id} ${task.steer.state}`)}` : "";
          lines.push(`  ${paint(theme, "success", task.kind === "steer" ? "steered" : "started")} ${paint(theme, "muted", "·")} ${identity(theme, task.conversationId, task.runId)}${receipt}`);
        }
        return lines;
      });
    case "cancel":
      return blocks(details.runs, run => run.error ? [
        `${errorMarker(theme)} ${paint(theme, "text", run.runId)} ${paint(theme, "muted", "· not cancelled")}`,
        `  ${paint(theme, "error", run.error)}`,
      ] : [
        `${arrow(theme)} ${paint(theme, "text", run.runId)} ${paint(theme, "muted", "· cancelled")}`,
        ...(run.conversationId ? [`  ${identity(theme, run.conversationId, run.runId)}`] : []),
      ]);
    case "inspect":
      return blocks(details.runs, run => {
        if ("error" in run) return [
          `${errorMarker(theme)} ${paint(theme, "text", run.runId)} ${paint(theme, "muted", "· not inspected")}`,
          `  ${paint(theme, "error", run.error)}`,
        ];
        const label = run.label || run.agent || run.runId;
        const lines = [
          `${statusMarker(theme, run.status)} ${paint(theme, "text", label)} ${paint(theme, "muted", "·")} ${statusText(theme, run.status)}${run.phase ? ` ${paint(theme, "muted", `· ${run.phase.replaceAll("_", " ")}`)}` : ""}`,
          `  ${identity(theme, run.conversationId, run.runId)} ${paint(theme, "muted", `· ${run.turns} turns · ${run.compactions} compactions · ${run.elapsedMs}ms`)}`,
        ];
        if (run.messageSnippet) lines.push(`  ${paint(theme, "dim", `[partial] ${run.messageSnippet}`)}`);
        if (run.errorSnippet) lines.push(`  ${paint(theme, "error", run.errorSnippet)}`);
        for (const tool of run.recentTools) lines.push(`  ${paint(theme, "muted", `${tool.tool}${tool.summary ? `(${tool.summary})` : ""} · ${tool.status}`)}`);
        for (const steer of run.steers) lines.push(`  ${paint(theme, "muted", `steer #${steer.id} · ${steer.state}`)}`);
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
      return lines.length ? lines : [success(theme, "No conversations removed")];
    }
  }
}

function joinLines(runs: readonly JoinedRunRenderItem[], expanded: boolean, partial: boolean, theme?: ThemeLike): string[] {
  if (runs.length === 0) return [success(theme, "No runs joined")];
  const rendered = runs.map((run, index) => renderJoinRoot(run, index, expanded, partial, theme));
  return expanded ? joinBlocks(rendered) : rendered.flat();
}

function renderJoinRoot(run: JoinedRunRenderItem, index: number, expanded: boolean, partial: boolean, theme?: ThemeLike): string[] {
  const terminal = isTerminal(run.status);
  const failed = terminal && run.status !== "completed";
  const label = run.label || run.agent || run.runId || `run ${index + 1}`;
  const meta = [run.agent, run.kind].filter(Boolean).join(" · ");
  const lines = [
    `${statusMarker(theme, run.status)} ${paint(theme, "text", label)}${meta ? ` ${paint(theme, "muted", `· ${meta}`)}` : ""} ${paint(theme, "muted", "·")} ${statusText(theme, run.status)}${runStats(run, theme)}`,
  ];
  const message = run.output ?? run.error;
  if (terminal && !expanded) {
    if (failed && message) lines.push(`  ${paint(theme, "error", truncate(message, 320))}`);
    return lines;
  }

  if (expanded) {
    lines.push(`  ${run.conversationId ? identity(theme, run.conversationId, run.runId) : paint(theme, "muted", run.runId)}`);
    if (run.prompt) appendSection(lines, [`  ${paint(theme, "dim", run.prompt)}`]);
  } else if (partial && !run.activity?.length && !run.joins?.length) {
    lines.push(`  ${paint(theme, "dim", "waiting for result")}`);
  }

  const activity = renderJoinNode(run.activity, run.joins, run.background, "  ", expanded, theme);
  if (expanded) appendSection(lines, activity);
  else lines.push(...activity);
  if (terminal && message) appendSection(lines, [`  ${paint(theme, failed ? "error" : "dim", truncate(message, 1200))}`]);
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
  const lines = [`${indent}${statusMarker(theme, group.status)} ${paint(theme, failed ? "error" : "muted", summary)}`];
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
      `${indent}${paint(theme, "muted", connector)} ${statusMarker(theme, target.status)} ${paint(theme, "text", label)}${paint(theme, "muted", agent)} ${paint(theme, "muted", "·")} ${statusText(theme, target.status)}${runStats(target, theme)}`,
    ];
    const childIndent = `${indent}${last ? "   " : `${paint(theme, "muted", "│")}  `}  `;
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

function runStats(run: { elapsedMs?: number; turns?: number; tokens?: number }, theme?: ThemeLike): string {
  const parts = [
    run.elapsedMs !== undefined ? formatElapsed(run.elapsedMs) : undefined,
    run.turns !== undefined ? count(run.turns, "turn") : undefined,
    run.tokens !== undefined ? formatTokens(run.tokens) : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length ? ` ${paint(theme, "muted", `· ${parts.join(" · ")}`)}` : "";
}

function truncate(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function callSuffix(action: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  if (action === "spawn") return arrayCount(input.spawns, "task");
  if (action === "resume") return arrayCount(input.resumes, "task");
  if (action === "steer") return arrayCount(input.messages, "message");
  if (action === "cancel" || action === "inspect" || action === "join") return arrayCount(input.runIds, "run");
  if (action === "remove") return arrayCount(input.conversationIds, "conversation");
  return "";
}

function arrayCount(value: unknown, noun: string): string {
  return Array.isArray(value) && value.length ? count(value.length, noun) : "";
}

function dispatchOutcomeSummary(spawned: number, resumed: number, steered: number, rejected: number, theme?: ThemeLike): string {
  const parts: string[] = [];
  if (spawned) parts.push(`Started ${count(spawned, "new conversation")}`);
  if (resumed) parts.push(`${parts.length ? "resumed" : "Resumed"} ${count(resumed, "conversation")}`);
  if (steered) parts.push(`${parts.length ? "steered" : "Steered"} ${count(steered, "run")}`);
  if (!parts.length) parts.push("No tasks accepted");
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

function appendSection(lines: string[], section: readonly string[]): void {
  if (section.length === 0) return;
  if (lines.length > 0) lines.push("");
  lines.push(...section);
}

function blocks<T>(items: readonly T[], render: (item: T, index: number) => string[]): string[] {
  return joinBlocks(items.map(render));
}

function joinBlocks(items: readonly string[][]): string[] {
  return items.flatMap((item, index) => index === items.length - 1 ? item : [...item, ""]);
}

function taskLabel(task: DispatchTaskRenderItem, index: number): string {
  return task.label || task.agent || task.conversationId || `task ${index + 1}`;
}

function conversationLabel(conversation: { label?: string; agent: string }): string {
  return conversation.label || conversation.agent;
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
