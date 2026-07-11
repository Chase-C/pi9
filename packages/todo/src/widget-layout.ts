import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { todoGlyph } from "./glyphs.js";
import type { Todo, TodoPhase, TodoState } from "./types.js";

export type TodoWidgetLayoutOptions = {
  showCompleted?: boolean;
  maxVisible?: number;
  fallbackGlyphs?: boolean;
};

type ThemeLike = Partial<Pick<Theme, "bold" | "fg" | "strikethrough">>;

type DisplayTask = Todo & { phaseIndex: number; taskIndex: number };

/**
 * Produces compact widget rows. Every returned row is constrained to the supplied display width;
 * the component may subsequently wrap a row when a host chooses a narrower cell.
 */
export function renderTodoWidgetLines(
  state: TodoState | undefined,
  theme: ThemeLike | undefined,
  width: number,
  options: TodoWidgetLayoutOptions = {},
): string[] {
  const safeWidth = Math.max(1, Math.floor(width) || 1);
  const phases = Array.isArray(state?.phases) ? state.phases : [];
  const showCompleted = options.showCompleted === true;
  const candidates = phases.flatMap((phase, phaseIndex) =>
    phase.tasks
      .filter(task => showCompleted || !isTerminal(task))
      .map((task, taskIndex) => ({ ...task, phaseIndex, taskIndex })),
  );
  if (candidates.length === 0) return [];

  const maxVisible = boundedMaxVisible(options.maxVisible);
  // Active work always wins the limited preview, followed by pending work.
  const selected = new Set(
    [...candidates]
      .sort((left, right) => taskPriority(left) - taskPriority(right) || left.phaseIndex - right.phaseIndex || left.taskIndex - right.taskIndex)
      .slice(0, maxVisible)
      .map(task => task.id),
  );
  const lines: string[] = [fit(summary(phases), safeWidth)];

  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const phase = phases[phaseIndex];
    const visible = candidates
      .filter(task => task.phaseIndex === phaseIndex && selected.has(task.id))
      .sort((left, right) => taskPriority(left) - taskPriority(right) || left.taskIndex - right.taskIndex);
    if (visible.length === 0) continue;
    lines.push(fit(phaseSummary(phase), safeWidth));
    for (const task of visible) lines.push(fit(taskLine(task, theme, options.fallbackGlyphs), safeWidth));
  }

  const hidden = candidates.length - selected.size;
  if (hidden > 0) lines.push(fit(`  +${hidden} more`, safeWidth));
  return lines;
}

/** Alias kept for callers that prefer a builder-style name. */
export const buildTodoWidgetLines = renderTodoWidgetLines;

function boundedMaxVisible(value: number | undefined): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.floor(value!));
}

function summary(phases: TodoPhase[]): string {
  const tasks = phases.flatMap(phase => phase.tasks);
  const active = tasks.filter(isActive).length;
  const pending = tasks.filter(task => task.status === "pending").length;
  const completed = tasks.filter(task => task.status === "completed").length;
  return ["Todo", ...(active ? [`${active} active`] : []), ...(pending ? [`${pending} pending`] : []), ...(completed ? [`${completed} completed`] : [])].join(" · ");
}

function phaseSummary(phase: TodoPhase): string {
  const active = phase.tasks.filter(isActive).length;
  const pending = phase.tasks.filter(task => task.status === "pending").length;
  const completed = phase.tasks.filter(task => task.status === "completed").length;
  const cancelled = phase.tasks.filter(task => task.status === "cancelled").length;
  return [phase.name, ...(active ? [`${active} active`] : []), ...(pending ? [`${pending} pending`] : []), ...(completed ? [`${completed} completed`] : []), ...(cancelled ? [`${cancelled} cancelled`] : [])].join(" · ");
}

function taskLine(task: Todo, theme: ThemeLike | undefined, fallbackGlyphs = false): string {
  const marker = todoGlyph(task.status, fallbackGlyphs);
  const color = task.status === "in_progress" ? "text" : task.status === "completed" ? "success" : "dim";
  const content = (task.status === "completed" || task.status === "cancelled") && theme?.strikethrough
    ? theme.strikethrough(task.content)
    : task.content;
  let line = `  ${marker} [${task.id}] ${content}`;
  if (isActive(task) && theme?.bold) line = theme.bold(line);
  return theme?.fg ? theme.fg(color, line) : line;
}

function taskPriority(task: Todo): number {
  if (isActive(task)) return 0;
  if (task.status === "pending") return 1;
  return 2;
}

function isActive(task: Todo): boolean {
  return task.status === "in_progress";
}

function isTerminal(task: Todo): boolean {
  return task.status === "completed" || task.status === "cancelled";
}

function fit(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…");
}
