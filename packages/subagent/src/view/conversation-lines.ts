import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AgentRunSnapshot, AgentSnapshot } from "../domain/agent-snapshot.js";
import type { SubagentDisplaySettings } from "../config/settings.js";
import { effectiveStatus } from "../domain/agent-decisions.js";
import { hasBothColumnSections, maxLineWidth, resolveWidgetLayout, zipWidgetColumns } from "./widget-layout.js";

export type WidgetSectionTitle = "Active Runs" | "Completed Runs" | "Conversations";
export interface WidgetRow { conversation: AgentSnapshot; run?: AgentRunSnapshot; text: string; status: string }
export interface WidgetSection { title: WidgetSectionTitle; rows: WidgetRow[]; overflow?: number }
export interface WidgetModel { sections: WidgetSection[] }

export function formatConversationIdentityLine(conversation: AgentSnapshot): string {
  return `${conversation.config.name}${conversation.label ? ` · ${conversation.label}` : ""} · ${conversation.conversationId}`;
}
export function formatRunConversationLine(conversation: AgentSnapshot, run: AgentRunSnapshot = conversation.currentRun ?? conversation.runs.at(-1)!): string {
  return `${formatConversationIdentityLine(conversation)} · ${run.runId} · ${effectiveStatus(run.status)}`;
}
export const formatConversationLine = formatRunConversationLine;

export function buildWidgetModel(conversations: AgentSnapshot[], _now = Date.now(), display?: SubagentDisplaySettings): WidgetModel {
  const active: WidgetRow[] = []; const completed: WidgetRow[] = []; const empty: WidgetRow[] = [];
  for (const conversation of conversations) {
    const run = conversation.currentRun ?? conversation.runs.at(-1);
    if (!run) { empty.push({ conversation, text: formatConversationIdentityLine(conversation), status: "conversation" }); continue; }
    const row = { conversation, run, text: formatRunConversationLine(conversation, run), status: effectiveStatus(run.status) };
    (run.status.kind === "done" ? completed : active).push(row);
  }
  const limit = display?.widgetMaxRowsPerSection ?? Infinity;
  const section = (title: WidgetSectionTitle, rows: WidgetRow[]): WidgetSection | undefined => rows.length ? { title, rows: rows.slice(0, limit), ...(rows.length > limit ? { overflow: rows.length - limit } : {}) } : undefined;
  return { sections: [section("Active Runs", active), section("Completed Runs", completed), section("Conversations", empty)].filter((x): x is WidgetSection => !!x) };
}

export function formatThemedWidgetRow(row: WidgetRow, theme?: Pick<Theme, "fg">): string {
  const color: ThemeColor = row.status === "running" ? "accent" : row.status === "queued" ? "warning" : row.status === "completed" ? "success" : row.status === "conversation" ? "muted" : "error";
  return theme?.fg ? theme.fg(color, row.text) : row.text;
}
export function renderWidgetModelLines(model: WidgetModel, _now = Date.now(), format = (row: WidgetRow) => row.text, options: { layout?: "auto" | "columns" | "stacked"; width?: number } = {}): string[] {
  const render = (s: WidgetSection) => [`${s.title}`, ...s.rows.map(format), ...(s.overflow ? [`+${s.overflow} more`] : [])];
  const lines = model.sections.map(render);
  if (lines.length === 2 && resolveWidgetLayout(options.layout ?? "stacked", options.width ?? 80, hasBothColumnSections(model.sections), maxLineWidth(lines[0])) === "columns") return zipWidgetColumns(lines[0], lines[1], options.width ?? 80);
  return lines.flatMap((value, index) => index ? ["", ...value] : value);
}
export function formatWidgetLines(conversations: AgentSnapshot[], now = Date.now(), display?: SubagentDisplaySettings): string[] { return renderWidgetModelLines(buildWidgetModel(conversations, now, display), now); }
export function stringifyWidgetModel(model: WidgetModel): string { return renderWidgetModelLines(model).join("\n"); }
