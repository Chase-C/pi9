import type { Component } from "@earendil-works/pi-tui";

import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentGroupView, AgentRunStatus } from "../domain/agent-view.js";
import type { BackgroundResult } from "../runtime/agent-manager.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentDisplaySettings } from "../config/settings.js";
import { compact, effectiveStatus } from "./view-helpers.js";
import { serializeGroup } from "./serialize.js";
import {
  applyBold,
  SubagentTextComponent,
  type Bold,
  type DisplayLine,
  type DisplayStatus,
  type Theme,
} from "./text-component.js";
import {
  expandedLines,
  formatElapsed,
  orderAsTree,
  plural,
  snippetLines,
  statusColorForOutcome,
  statusPresentation,
} from "./format-helpers.js";
import { formatRunSessionLine, formatSessionLine } from "./session-lines.js";
import {
  narrowDetails,
  type AgentListingEntry,
  type BackgroundSpawnHandle,
  type InventoryFilter,
  type RemoveSummary,
  type RunOutcome,
} from "./details.js";

const DEFAULT_DISPLAY = DEFAULT_SUBAGENT_SETTINGS.display;

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

export function formatSubagentToolLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): string[] {
  return (formatSubagentToolDisplayLines(details, expanded, now, undefined, display) ?? []).map(line => line.text);
}

export function createSubagentTextComponent(
  details: unknown,
  expanded: boolean,
  theme: Theme,
  now = Date.now(),
  display: SubagentDisplaySettings = DEFAULT_DISPLAY,
): Component | undefined {
  // Probe the theme eagerly so a broken theme throws here and renderResult can fall back to plain text.
  if (theme?.fg) theme.fg("muted", "");
  const lines = formatSubagentToolDisplayLines(details, expanded, now, theme?.bold, display);
  return lines ? new SubagentTextComponent(lines, theme) : undefined;
}

function formatSubagentToolDisplayLines(
  details: unknown,
  expanded = false,
  now = Date.now(),
  bold: Bold | undefined,
  display: SubagentDisplaySettings,
): DisplayLine[] | undefined {
  const narrowed = narrowDetails(details);
  if (!narrowed) return undefined;

  switch (narrowed.view) {
    case "agents":
      return formatAgentListLines(narrowed.agents, expanded, bold, display).map(text => ({ text }));

    case "run-results":
      return formatRunResultsLines(narrowed.outcomes, expanded, bold, display);

    case "run": {
      if (narrowed.subtree && narrowed.subtree.length > 0) {
        const ordered = orderAsTree(narrowed.subtree);
        const indent = (depth: number, line: DisplayLine): DisplayLine => ({
          ...line,
          text: `${"  ".repeat(depth)}${line.text}`,
        });
        if (!expanded) {
          return ordered.map(({ agent: row, depth }) => indent(depth, formatRunSessionLine(row, now, bold)));
        }
        return ordered.flatMap(({ agent: row, depth }, index) =>
          expandedLines(indent(depth, formatRunSessionLine(row, now, bold)), row, true, index < ordered.length - 1, display));
      }
      const { sessions } = narrowed.group;
      if (!expanded) return sessions.map(row => formatRunSessionLine(row, now, bold));
      return sessions.flatMap((row, index) =>
        expandedLines(formatRunSessionLine(row, now, bold), row, true, index < sessions.length - 1, display));
    }

    case "inventory": {
      const { sessions, filter } = narrowed;
      if (sessions.length === 0) return [{ text: "No subagent sessions." }];
      if (!expanded && sessions.length > 1) {
        return [formatViewGroupLine(serializeGroup(sessions), filter)];
      }
      const ordered = orderAsTree(sessions);
      return expanded
        ? ordered.flatMap(({ agent: row, depth }, index) => expandedLines(
            { text: `${"  ".repeat(depth)}${formatSessionLine(row, now, bold, display)}`, status: statusPresentation(row.status).color },
            row,
            false,
            index < ordered.length - 1,
            display,
          ))
        : ordered.map(({ agent: row, depth }) => ({ text: `${"  ".repeat(depth)}${formatSessionLine(row, now, bold, display)}`, status: statusPresentation(row.status).color }));
    }

    case "remove-summary":
      return formatRemoveSummaryLines(narrowed.summary, expanded);

    case "background-started":
      return formatBackgroundStartedLines(narrowed.handles, narrowed.count, expanded, bold);

    case "background-results":
      return formatBackgroundResultsLines(narrowed.results, expanded, bold, display);
  }
}

function formatRunResultsLines(outcomes: RunOutcome[], expanded: boolean, bold: Bold | undefined, display: SubagentDisplaySettings): DisplayLine[] {
  const counts = new Map<AgentRunStatus, number>();
  for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
  const ordered: AgentRunStatus[] = ["completed", "error", "aborted", "interrupted", "skipped"];
  const segments = [plural(outcomes.length, "subagent")];
  for (const status of ordered) {
    const count = counts.get(status);
    if (count) segments.push(`${count} ${status}`);
  }
  const head: DisplayLine = {
    text: segments.join(" · "),
    status: outcomes.some(o => o.status !== "completed") ? "error" : "completed",
  };
  if (!expanded) return [head];

  const lines: DisplayLine[] = [head];
  for (const outcome of outcomes) {
    lines.push({ text: "" });
    const color = statusColorForOutcome(outcome.status);
    const labelSegment = outcome.label ? `  ${outcome.label}` : "";
    const sessionSegment = outcome.sessionId ? ` · session:${outcome.sessionId}` : "";
    const resumedSegment = outcome.resumed ? " · resumed" : "";
    lines.push({
      text: `${applyBold(bold, outcome.agent)}${labelSegment} · ${outcome.status}${sessionSegment}${resumedSegment}`,
      status: color,
    });
    const snippet = outcome.status === "completed" ? outcome.output : outcome.error;
    if (snippet) {
      const snippetLabel = outcome.status === "completed" ? "Result" : "Error";
      lines.push(...snippetLines(snippetLabel, snippet, 2, color, display));
    }
  }
  return lines;
}

function formatBackgroundResultsLines(results: BackgroundResult[], expanded: boolean, bold: Bold | undefined, display: SubagentDisplaySettings): DisplayLine[] {
  let ready = 0;
  let notReady = 0;
  let errors = 0;
  for (const entry of results) {
    if ("error" in entry) errors += 1;
    else if (entry.ready) ready += 1;
    else notReady += 1;
  }
  const segments = [plural(results.length, "result")];
  if (ready > 0) segments.push(`${ready} ready`);
  if (notReady > 0) segments.push(`${notReady} not ready`);
  if (errors > 0) segments.push(plural(errors, "error"));
  const head: DisplayLine = { text: segments.join(" · ") };
  if (!expanded) return [head];

  const lines: DisplayLine[] = [head];
  for (const entry of results) {
    lines.push({ text: "" });
    if ("error" in entry) {
      lines.push({ text: `${entry.sessionId} · error: ${entry.error}`, status: "error" });
    } else if (entry.ready) {
      const result = entry.result;
      const color = statusColorForOutcome(result.status);
      const labelSegment = result.label ? `  ${result.label}` : "";
      lines.push({
        text: [`${applyBold(bold, result.agent)}${labelSegment}`, result.status, `session:${entry.sessionId}`].join(" · "),
        status: color,
      });
      const snippet = result.status === "completed" ? result.output : result.error ?? result.status;
      if (snippet) {
        const snippetLabel = result.status === "completed" ? "Result" : "Error";
        lines.push(...snippetLines(snippetLabel, snippet, 2, color, display));
      }
    } else {
      const labelSegment = entry.label ? `  ${entry.label}` : "";
      lines.push({
        text: `${applyBold(bold, entry.agent)}${labelSegment} · ${entry.status} · ${formatElapsed(0, entry.elapsedMs)}`,
        status: entry.status,
      });
    }
  }
  return lines;
}

function formatBackgroundStartedLines(handles: BackgroundSpawnHandle[], count: number, expanded: boolean, bold?: Bold): DisplayLine[] {
  const head: DisplayLine = { text: `${plural(count, "background subagent")} started` };
  if (!expanded) return [head];
  const lines: DisplayLine[] = [head];
  for (const handle of handles) {
    const label = handle.label ?? handle.sessionId;
    const text = handle.label
      ? `  ${applyBold(bold, label)} · ${handle.sessionId}`
      : `  ${applyBold(bold, handle.sessionId)}`;
    lines.push({ text });
  }
  return lines;
}

function formatRemoveSummaryLines(summary: RemoveSummary, expanded: boolean): DisplayLine[] {
  const errors = summary.errors ?? [];
  const parts = [`Removed ${plural(summary.removed, "session")}`];
  if (summary.aborted > 0) parts.push(`aborted ${summary.aborted}`);
  if (errors.length > 0) parts.push(plural(errors.length, "error"));
  const head: DisplayLine = { text: parts.join(" · ") };
  if (!expanded) return [head];
  const lines: DisplayLine[] = [head];
  for (const id of summary.sessionIds) lines.push({ text: `  ${id}` });
  if (errors.length > 0) {
    lines.push({ text: "" });
    lines.push({ text: "Errors:" });
    for (const entry of errors) lines.push({ text: `  ${entry.sessionId}: ${entry.error}`, status: "error" });
  }
  return lines;
}

const ORDERED_GROUP_STATUSES = ["queued", "running", "completed", "error", "interrupted", "skipped", "aborted"];

function formatViewGroupLine(group: AgentGroupView, filter?: InventoryFilter): DisplayLine {
  const known = new Set(ORDERED_GROUP_STATUSES);
  const format = (status: string) => `${group.statusCounts[status]} ${status}`;
  const counts = ORDERED_GROUP_STATUSES.filter(status => group.statusCounts[status]).map(format);
  const extras = Object.keys(group.statusCounts).filter(status => !known.has(status)).sort().map(format);
  const outcome = groupOutcome(group);
  const outcomeLabel = outcome === "queued" ? "running" : outcome;
  const filterSegment = filter?.status && filter.status.length > 0 ? [`filter:${filter.status.join(",")}`] : [];
  return {
    text: [`${group.sessions.length} subagents`, ...counts, ...extras, `outcome:${outcomeLabel}`, ...filterSegment].join(" · "),
    status: outcome,
  };
}

function groupOutcome(group: AgentGroupView): DisplayStatus {
  if (group.isError) return "error";
  if (group.sessions.some(s => effectiveStatus(s.status) === "running")) return "running";
  if (group.sessions.some(s => effectiveStatus(s.status) === "queued")) return "queued";
  return "completed";
}

function formatAgentListLines(agents: AgentListingEntry[], expanded: boolean, bold: Bold | undefined, display: SubagentDisplaySettings = DEFAULT_DISPLAY): string[] {
  if (!expanded) {
    return agents.slice(0, display.collapsedAgentListLimit).map(agent => `${applyBold(bold, agent.name)} · ${compact(agent.description, display.collapsedDescriptionLength)}`);
  }

  return agents.flatMap((agent, index) => {
    const lines = [
      applyBold(bold, agent.name),
      ...agent.description.split(/\r?\n/).map(line => `  ${line}`),
      `  Model: ${agent.model ?? "default"}`,
      `  Thinking: ${agent.thinking ?? "default"}`,
      `  Tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}`,
      `  Skills: ${agent.skills?.length ? agent.skills.join(", ") : "none"}`,
      `  Resumable: ${agent.resumable}`,
    ];
    if (agent.sourcePath) lines.push(`  Path: ${agent.sourcePath}`);
    if (index < agents.length - 1) lines.push("");
    return lines;
  });
}
