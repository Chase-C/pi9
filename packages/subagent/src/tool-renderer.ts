import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { AgentSource, EffectiveExecutionConfig, ExecutionOverrides } from "./agents.js";
import { GENERATION_STATUSES, type GenerationKind, type GenerationPhase, type GenerationRef, type GenerationStatus, type SteerReceipt } from "./conversation.js";
import type { ConversationId } from "./identifiers.js";
import { formatElapsed, formatTokens, statusColor, truncateText } from "./generation-format.js";
import { SUBAGENT_STATUSES, type DispatchTaskKind, type SubagentAction, type SubagentStatus } from "./schema.js";
import type { SubagentErrorEnvelope, SubagentResultsEnvelope } from "./tool-contract.js";

type DisplayStatus = GenerationStatus | SubagentStatus;
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
  subagentId?: ConversationId;
  steer?: SteerReceipt;
  error?: string;
}

export interface ListedDescendantRenderItem {
  subagentId: ConversationId;
  agent: string;
  label: string;
  status: SubagentStatus;
  descendants?: ListedDescendantRenderItem[];
}

export interface ListedConversationRenderItem {
  subagentId: ConversationId;
  agent: string;
  label: string;
  status: SubagentStatus;
  joined?: boolean;
  actionHints: readonly SubagentAction[];
  failure?: string;
  descendants: ListedDescendantRenderItem[];
}

export interface JoinActivityRenderItem {
  toolCallId?: string;
  tool: string;
  summary?: string;
}

export interface CancelledSubagentRenderItem {
  subagentId: string;
  agent?: string;
  label?: string;
  status?: SubagentStatus;
  error?: string;
}

export interface InspectedSubagentErrorRenderItem {
  subagentId: string;
  error: string;
}

export interface GenerationMetricsRenderItem {
  elapsedMs: number;
  turns: number;
  compactions: number;
  tokens: number;
}

export interface GenerationHistoryRenderItem extends GenerationMetricsRenderItem {
  generation: number;
  kind: GenerationKind;
  status: SubagentStatus;
  joined: boolean;
  steers: readonly SteerReceipt[];
}

export interface InspectedGenerationRenderItem {
  subagentId: ConversationId;
  parentSubagentId?: ConversationId;
  depth?: number;
  requestedOverrides?: ExecutionOverrides;
  effectiveConfig?: EffectiveExecutionConfig;
  agent?: string;
  label?: string;
  status: SubagentStatus;
  phase?: GenerationPhase;
  generation: number;
  metrics: GenerationMetricsRenderItem;
  totalMetrics: GenerationMetricsRenderItem;
  history: readonly GenerationHistoryRenderItem[];
  messageSnippet?: string;
  errorSnippet?: string;
  recentTools: Array<JoinActivityRenderItem & { status: "running" | "completed" | "error" | "interrupted" }>;
  steers: readonly SteerReceipt[];
}

/** A join invocation, retained in invocation order (including repeated targets). */
export interface JoinInvocationRenderItem {
  status: SubagentStatus;
  targets: JoinTargetRenderItem[];
  error?: string;
  toolCallId?: string;
}

/** A joined descendant. Deliberately has no output field: descendant answers are not UI data. */
export interface JoinTargetRenderItem {
  subagentId?: ConversationId;
  agent?: string;
  label?: string;
  status: SubagentStatus;
  elapsedMs?: number;
  turns?: number;
  tokens?: number;
  activity?: JoinActivityRenderItem[];
  joins?: JoinInvocationRenderItem[];
  background?: JoinBackgroundOwnerRenderItem[];
  error?: string;
}

export interface JoinBackgroundRenderItem {
  subagentId: ConversationId;
  agent?: string;
  label?: string;
  status: SubagentStatus;
  detachedAtFinal?: boolean;
}

export interface JoinBackgroundOwnerRenderItem {
  ownerLabel?: string;
  entries: JoinBackgroundRenderItem[];
}

export interface JoinedGenerationRenderItem {
  subagentId?: ConversationId;
  agent?: string;
  label?: string;
  kind?: GenerationKind;
  prompt?: string;
  status: SubagentStatus;
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

type RemoveRenderItem =
  | { readonly ok: true; readonly removedIds: readonly ConversationId[] }
  | { readonly ok: false; readonly subagentId: string; readonly error: string };

export interface DispatchRenderView {
  readonly tasks: readonly DispatchTaskRenderItem[];
}

export interface JoinRenderView {
  readonly entries: readonly JoinedGenerationRenderItem[];
}

type ResultDetails<A extends SubagentResultsEnvelope["action"], T> = {
  readonly response: SubagentResultsEnvelope<A, T>;
};

/** Internal lifecycle correlation; observedGenerations is not part of the serialized response envelope. */
type SubagentResultDetails =
  | ResultDetails<"agents", AgentRenderItem>
  | ResultDetails<"list", ListedConversationRenderItem>
  | (ResultDetails<"spawn" | "resume" | "steer", unknown> & { readonly view: DispatchRenderView })
  | (ResultDetails<"cancel", CancelledSubagentRenderItem> & { readonly observedGenerations: readonly GenerationRef[] })
  | (ResultDetails<"inspect", InspectedGenerationRenderItem | InspectedSubagentErrorRenderItem> & { readonly observedGenerations: readonly GenerationRef[] })
  | (ResultDetails<"join", unknown> & { readonly view: JoinRenderView })
  | ResultDetails<"remove", RemoveRenderItem>;

export type SubagentToolDetails = SubagentResultDetails | { readonly response: SubagentErrorEnvelope };

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
  const partialDetails: Partial<SubagentToolDetails> = details;
  if (!("response" in partialDetails) || typeof partialDetails.response !== "object" || partialDetails.response === null) {
    return new Text(fallbackText(result), 0, 0);
  }
  if ("error" in partialDetails.response) return new Text(paint(theme, "error", partialDetails.response.error), 0, 0);
  const resultDetails = details as SubagentResultDetails;

  const lines = options.expanded
    ? expandedLines(resultDetails, theme)
    : collapsedLines(resultDetails, options.isPartial === true, theme);
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

function collapsedLines(details: SubagentResultDetails, partial: boolean, theme?: ThemeLike): string[] {
  switch (details.response.action) {
    case "agents": {
      const agents = details.response.results;
      if (agents.length === 0) return [success(theme, "No agents available")];
      return [
        success(theme, `Found ${count(agents.length, "available agent")}`),
        secondary(agents.map(agent => agent.name), theme),
      ];
    }
    case "list": {
      const conversations = details.response.results;
      if (conversations.length === 0) return [success(theme, "No subagents found")];
      return [
        success(theme, `Found ${count(conversations.length, "subagent")}${statusSummary(conversations.map(conversation => conversation.status), theme)}`),
        secondary(conversations.map(conversationLabel), theme),
      ];
    }
    case "spawn":
    case "resume":
    case "steer": {
      const tasks = dispatchTasks(details);
      const accepted = tasks.filter(task => task.subagentId);
      const rejected = tasks.length - accepted.length;
      const spawned = accepted.filter(task => task.kind === "spawn").length;
      const resumed = accepted.filter(task => task.kind === "resume").length;
      const steered = accepted.filter(task => task.kind === "steer").length;
      const outcome = dispatchOutcomeSummary(spawned, resumed, steered, rejected, theme);
      const labels = tasks.map((task, index) => taskLabel(task, index));
      return labels.length ? [success(theme, outcome), secondary(labels, theme)] : [success(theme, outcome)];
    }
    case "cancel": {
      const entries = details.response.results;
      const cancelled = entries.filter(entry => entry.status === "cancelled").length;
      const errors = entries.length - cancelled;
      const summary = [`Cancelled ${count(cancelled, "subagent")}`];
      if (errors) summary.push(count(errors, "error"));
      return [success(theme, summary.join(paint(theme, "muted", " · "))), secondary(entries.map(entry => entry.subagentId), theme)];
    }
    case "inspect": {
      const entries = details.response.results;
      if (entries.length === 0) return [success(theme, "No subagents inspected")];
      const inspected = entries.filter((entry): entry is InspectedGenerationRenderItem => !("error" in entry));
      const errors = entries.length - inspected.length;
      const summary = inspected.length
        ? `Inspected ${count(inspected.length, "subagent")}${statusSummary(inspected.map(entry => entry.status), theme)}${errors ? `${paint(theme, "muted", " · ")}${count(errors, "error")}` : ""}`
        : `Inspected ${count(errors, "target")} ${paint(theme, "muted", "·")} ${count(errors, "error")}`;
      return [
        success(theme, summary),
        secondary(entries.map(entry => "error" in entry ? entry.subagentId : entry.label || entry.agent || entry.subagentId), theme),
      ];
    }
    case "join":
      return joinLines(joinEntries(details), false, partial, theme);
    case "remove": {
      const removedIds = removedSubagentIds(details.response.results);
      const errors = details.response.results.filter((item): item is Extract<RemoveRenderItem, { ok: false }> => !item.ok);
      const summary = [`Removed ${count(removedIds.length, "subagent")}`];
      if (errors.length) summary.push(count(errors.length, "error"));
      const lines = [success(theme, summary.join(paint(theme, "muted", " · ")))];
      if (removedIds.length) lines.push(secondary(removedIds, theme));
      return lines;
    }
  }
}

function expandedLines(details: SubagentResultDetails, theme?: ThemeLike): string[] {
  switch (details.response.action) {
    case "agents": {
      const agents = details.response.results;
      if (agents.length === 0) return [success(theme, "No agents available")];
      return blocks(agents, agent => [
        `${arrow(theme)} ${paint(theme, "text", agent.name)} ${paint(theme, "muted", `· ${agent.source}`)}`,
        `  ${paint(theme, "dim", agent.description)}`,
        `  ${tag(theme, "model", agent.model ?? "inherit")} ${paint(theme, "muted", "·")} ${tag(theme, "thinking", agent.thinking ?? "inherit")}`,
        `  ${tag(theme, "tools", agent.tools?.join(", ") || "default toolset")}`,
      ]);
    }
    case "list": {
      const conversations = details.response.results;
      if (conversations.length === 0) return [success(theme, "No subagents found")];
      return blocks(conversations, conversation => [
        `${statusMarker(theme, conversation.status)} ${paint(theme, "text", conversationLabel(conversation))} ${paint(theme, "muted", `· ${conversation.agent} · ${statusText(theme, conversation.status)}`)}`,
        `  ${tag(theme, "subagent", conversation.subagentId)}${conversation.joined !== undefined ? paint(theme, "muted", ` · ${conversation.joined ? "joined" : "not joined"}`) : ""}`,
        ...(conversation.failure ? [`  ${paint(theme, "error", conversation.failure)}`] : []),
        ...renderDescendants(conversation.descendants, "  ", theme),
      ]);
    }
    case "spawn":
    case "resume":
    case "steer":
      return blocks(dispatchTasks(details), (task, index) => {
        const label = taskLabel(task, index);
        const meta = [task.agent, task.kind].filter(Boolean).join(" · ");
        const lines = [`${task.error ? errorMarker(theme) : arrow(theme)} ${paint(theme, "text", label)}${meta ? ` ${paint(theme, "muted", `· ${meta}`)}` : ""}`];
        if (task.prompt) lines.push(`  ${paint(theme, "dim", task.prompt)}`);
        if (task.error) lines.push(`  ${paint(theme, "error", task.error)}`);
        else if (task.subagentId) {
          const receipt = task.steer ? ` ${paint(theme, "muted", `· steer #${task.steer.id} ${task.steer.state}`)}` : "";
          lines.push(`  ${paint(theme, "success", task.kind === "steer" ? "steered" : "started")} ${paint(theme, "muted", "·")} ${tag(theme, "subagent", task.subagentId)}${receipt}`);
        }
        return lines;
      });
    case "cancel":
      return blocks(details.response.results, entry => entry.error ? [
        `${errorMarker(theme)} ${paint(theme, "text", entry.subagentId)} ${paint(theme, "muted", "· not cancelled")}`,
        `  ${paint(theme, "error", entry.error)}`,
      ] : [
        `${arrow(theme)} ${paint(theme, "text", entry.subagentId)} ${paint(theme, "muted", "· cancelled")}`,
      ]);
    case "inspect":
      return blocks(details.response.results, entry => {
        if ("error" in entry) return [
          `${errorMarker(theme)} ${paint(theme, "text", entry.subagentId)} ${paint(theme, "muted", "· not inspected")}`,
          `  ${paint(theme, "error", entry.error)}`,
        ];
        const label = entry.label || entry.agent || entry.subagentId;
        const lines = [
          `${statusMarker(theme, entry.status)} ${paint(theme, "text", label)} ${paint(theme, "muted", "·")} ${statusText(theme, entry.status)}${entry.phase ? ` ${paint(theme, "muted", `· ${entry.phase.replaceAll("_", " ")}`)}` : ""}`,
          `  ${tag(theme, "subagent", entry.subagentId)} ${paint(theme, "muted", `· generation ${entry.generation} · ${entry.metrics.turns} turns · ${entry.metrics.compactions} compactions · ${entry.metrics.elapsedMs}ms`)}`,
        ];
        if (entry.messageSnippet) lines.push(`  ${paint(theme, "dim", `[partial] ${entry.messageSnippet}`)}`);
        if (entry.errorSnippet) lines.push(`  ${paint(theme, "error", entry.errorSnippet)}`);
        for (const tool of entry.recentTools) lines.push(`  ${paint(theme, "muted", `${tool.tool}${tool.summary ? `(${tool.summary})` : ""} · ${tool.status}`)}`);
        for (const steer of entry.steers) lines.push(`  ${paint(theme, "muted", `steer #${steer.id} · ${steer.state}`)}`);
        return lines;
      });
    case "join":
      return joinLines(joinEntries(details), true, false, theme);
    case "remove": {
      const items = removedSubagentIds(details.response.results).map(subagentId => [
        `${arrow(theme)} ${paint(theme, "text", subagentId)} ${paint(theme, "muted", "· removed")}`,
        `  ${tag(theme, "subagent", subagentId)}`,
      ]);
      for (const error of details.response.results) {
        if (error.ok) continue;
        items.push([
          `${errorMarker(theme)} ${paint(theme, "text", error.subagentId)} ${paint(theme, "muted", "· not removed")}`,
          `  ${paint(theme, "error", error.error)}`,
        ]);
      }
      const lines = joinBlocks(items);
      return lines.length ? lines : [success(theme, "No subagents removed")];
    }
  }
}

function dispatchTasks(details: SubagentResultDetails): readonly DispatchTaskRenderItem[] {
  if ("view" in details && "tasks" in details.view) return details.view.tasks;
  throw new Error(`Missing dispatch render view for ${details.response.action}.`);
}

function joinEntries(details: SubagentResultDetails): readonly JoinedGenerationRenderItem[] {
  if ("view" in details && "entries" in details.view) return details.view.entries;
  throw new Error(`Missing join render view for ${details.response.action}.`);
}

function removedSubagentIds(items: readonly RemoveRenderItem[]): ConversationId[] {
  return items.flatMap(item => item.ok ? item.removedIds : []);
}

function joinLines(entries: readonly JoinedGenerationRenderItem[], expanded: boolean, partial: boolean, theme?: ThemeLike): string[] {
  if (entries.length === 0) return [success(theme, "No subagents joined")];
  const rendered = entries.map((entry, index) => renderJoinRoot(entry, index, expanded, partial, theme));
  return expanded ? joinBlocks(rendered) : rendered.flat();
}

function renderJoinRoot(entry: JoinedGenerationRenderItem, index: number, expanded: boolean, partial: boolean, theme?: ThemeLike): string[] {
  const terminal = isTerminal(entry.status);
  const failed = terminal && entry.status !== "completed";
  const label = entry.label || entry.agent || entry.subagentId || `subagent ${index + 1}`;
  const meta = entry.agent;
  const lines = [
    `${statusMarker(theme, entry.status)} ${paint(theme, "text", label)}${meta ? ` ${paint(theme, "muted", `· ${meta}`)}` : ""} ${paint(theme, "muted", "·")} ${statusText(theme, entry.status)}${generationStats(entry, theme)}`,
  ];
  const message = entry.output ?? entry.error;
  if (terminal && !expanded) {
    if (failed && message) lines.push(`  ${paint(theme, "error", truncateText(message, 320))}`);
    return lines;
  }

  if (expanded) {
    lines.push(`  ${tag(theme, "subagent", entry.subagentId ?? "unknown")}`);
    if (entry.prompt) appendSection(lines, [`  ${paint(theme, "dim", entry.prompt)}`]);
  } else if (partial && !entry.activity?.length && !entry.joins?.length) {
    lines.push(`  ${paint(theme, "dim", "waiting for result")}`);
  }

  const activity = renderJoinNode(entry.activity, entry.joins, entry.background, "  ", expanded, theme);
  if (expanded) appendSection(lines, activity);
  else lines.push(...activity);
  if (terminal && message) appendSection(lines, [`  ${paint(theme, failed ? "error" : "dim", truncateText(message, 1200))}`]);
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

function renderDescendants(descendants: readonly ListedDescendantRenderItem[], indent: string, theme?: ThemeLike): string[] {
  return descendants.flatMap((descendant, index) => {
    const connector = index === descendants.length - 1 ? "╰─" : "├─";
    return [
      `${indent}${paint(theme, "muted", connector)} ${statusMarker(theme, descendant.status)} ${paint(theme, "text", descendant.label)} ${paint(theme, "muted", `· ${descendant.agent} · ${descendant.status}`)}`,
      ...renderDescendants(descendant.descendants ?? [], `${indent}${index === descendants.length - 1 ? "   " : "│  "}`, theme),
    ];
  });
}

function renderActivity(activity: readonly JoinActivityRenderItem[] | undefined, omitted: ReadonlySet<string>, indent: string, theme?: ThemeLike): string[] {
  const all = (activity ?? []).filter(item => !item.toolCallId || !omitted.has(item.toolCallId));
  const recent = all.slice(-3).reverse();
  const lines = recent.map(item => {
    const summary = item.summary ? `(${truncateText(item.summary, 100)})` : "";
    return `${indent}${paint(theme, "muted", `${item.tool}${summary}`)}`;
  });
  const additional = all.length - recent.length;
  if (additional > 0) lines.push(`${indent}${paint(theme, "muted", `+${additional} tool calls`)}`);
  return lines;
}

function renderActiveJoin(group: JoinInvocationRenderItem, totalTools: number, indent: string, expanded: boolean, theme?: ThemeLike): string[] {
  const total = count(group.targets.length, "subagent");
  const toolCount = totalTools > 0 ? ` · ${count(totalTools, "total tool call")}` : "";
  return [
    `${indent}${paint(theme, "muted", `subagent join(${total})${toolCount}`)}`,
    ...renderJoinTargets(group.targets, indent, expanded, theme),
  ];
}

function renderTerminalJoin(group: JoinInvocationRenderItem, indent: string, expanded: boolean, theme?: ThemeLike): string[] {
  const failed = group.status !== "completed";
  const labels = group.targets.map(target => target.label || target.agent || target.subagentId || "unknown subagent");
  const summary = failed
    ? `join failed${group.error ? ` · ${group.error}` : ""}`
    : `joined ${group.targets.length}${labels.length ? ` · ${labels.join(", ")}` : ""}`;
  const lines = [`${indent}${statusMarker(theme, group.status)} ${paint(theme, failed ? "error" : "muted", summary)}`];
  if (expanded) lines.push(...renderJoinTargets(group.targets, indent, true, theme));
  return lines;
}

function renderJoinTargets(targets: readonly JoinTargetRenderItem[], indent: string, expanded: boolean, theme?: ThemeLike): string[] {
  return targets.flatMap((target, index) => {
    const last = index === targets.length - 1;
    const connector = last ? "╰─" : "├─";
    const label = target.label || target.agent || target.subagentId || "unknown subagent";
    const agent = target.agent && target.agent !== label ? ` · ${target.agent}` : "";
    const lines = [
      `${indent}${paint(theme, "muted", connector)} ${statusMarker(theme, target.status)} ${paint(theme, "text", label)}${paint(theme, "muted", agent)} ${paint(theme, "muted", "·")} ${statusText(theme, target.status)}${generationStats(target, theme)}`,
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
    const label = entry.label || entry.agent || entry.subagentId;
    const detached = entry.detachedAtFinal ? paint(theme, "warning", " · detached at final") : "";
    lines.push(`${indent}  ${paint(theme, "muted", label)} · ${statusText(theme, entry.status)} · ${tag(theme, "subagent", entry.subagentId)}${detached}`);
  }
  return lines;
}

function generationStats(generation: { elapsedMs?: number; turns?: number; tokens?: number }, theme?: ThemeLike): string {
  const parts = [
    generation.elapsedMs !== undefined ? formatElapsed(generation.elapsedMs) : undefined,
    generation.turns !== undefined ? count(generation.turns, "turn") : undefined,
    generation.tokens !== undefined ? formatTokens(generation.tokens) : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length ? ` ${paint(theme, "muted", `· ${parts.join(" · ")}`)}` : "";
}

function callSuffix(action: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  if (action === "spawn") return arrayCount(input.spawns, "task");
  if (action === "resume") return arrayCount(input.resumes, "task");
  if (action === "steer") return arrayCount(input.messages, "message");
  if (action === "cancel" || action === "inspect" || action === "join" || action === "remove") return arrayCount(input.subagentIds, "subagent");
  return "";
}

function arrayCount(value: unknown, noun: string): string {
  return Array.isArray(value) && value.length ? count(value.length, noun) : "";
}

function dispatchOutcomeSummary(spawned: number, resumed: number, steered: number, rejected: number, theme?: ThemeLike): string {
  const parts: string[] = [];
  if (spawned) parts.push(`Started ${count(spawned, "new subagent")}`);
  if (resumed) parts.push(`${parts.length ? "resumed" : "Resumed"} ${count(resumed, "subagent")}`);
  if (steered) parts.push(`${parts.length ? "steered" : "Steered"} ${count(steered, "subagent")}`);
  if (!parts.length) parts.push("No tasks accepted");
  let summary = parts.join(" and ");
  if (rejected) summary += paint(theme, "muted", ` · ${count(rejected, "rejected task")}`);
  return summary;
}

function statusSummary(statuses: readonly DisplayStatus[], theme?: ThemeLike): string {
  if (statuses.length === 0) return "";
  const order: readonly DisplayStatus[] = [...SUBAGENT_STATUSES, ...GENERATION_STATUSES.filter(status => !SUBAGENT_STATUSES.includes(status as SubagentStatus))];
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
  return task.label || task.agent || task.subagentId || `task ${index + 1}`;
}

function conversationLabel(conversation: { label?: string; agent: string }): string {
  return conversation.label || conversation.agent;
}

function tag(theme: ThemeLike | undefined, name: string, value: string): string {
  return `${paint(theme, "muted", name)} ${paint(theme, "accent", value)}`;
}

function statusText(theme: ThemeLike | undefined, status: DisplayStatus): string {
  return paint(theme, statusColor(status), status);
}

function statusMarker(theme: ThemeLike | undefined, status: DisplayStatus): string {
  if (status === "completed") return paint(theme, "success", "✓");
  if (status === "running") return paint(theme, "warning", "●");
  if (status === "queued") return paint(theme, "warning", "…");
  return paint(theme, statusColor(status), "×");
}

function isTerminal(status: DisplayStatus): boolean {
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
