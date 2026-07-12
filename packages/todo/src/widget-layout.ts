import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { todoGlyph } from "./glyphs.js";
import type { Todo, TodoPhase, TodoState } from "./types.js";

export type TodoWidgetLayoutOptions = {
  maxVisible?: number;
  fallbackGlyphs?: boolean;
  activeMarker?: string;
};

type ThemeLike = Partial<Pick<Theme, "bold" | "fg" | "strikethrough">>;

type DisplayTask = Todo & { taskIndex: number };

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
  if (phases.length === 0 || !phases.some(phase => phase.tasks.length > 0)) return [];

  const selectedPhaseIndex = selectPhase(phases);
  if (selectedPhaseIndex < 0) return [];
  const selectedPhase = phases[selectedPhaseIndex];
  const maxVisible = boundedMaxVisible(options.maxVisible);
  const selectedTasks = visibleTasks(selectedPhase.tasks, maxVisible);
  const lines: string[] = [fit(toolTitle(summary(phases), theme), safeWidth)];

  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const phase = phases[phaseIndex];
    const selected = phaseIndex === selectedPhaseIndex;
    lines.push(fit(phaseTitle(phase, phaseIndex, selected, theme), safeWidth));

    if (selected) {
      for (const task of selectedTasks) {
        lines.push(fit(taskLine(task, theme, options.fallbackGlyphs, options.activeMarker), safeWidth));
      }
      const openTasks = phase.tasks.filter(task => !isTerminal(task));
      const hidden = openTasks.length - selectedTasks.length;
      if (hidden > 0) lines.push(fit(`    +${hidden} more`, safeWidth));
      const terminalSummary = terminalTaskSummary(phase.tasks);
      if (terminalSummary) {
        const line = `    + ${terminalSummary}`;
        lines.push(fit(theme?.fg ? theme.fg("dim", line) : line, safeWidth));
      }
    }
  }

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
  const cancelled = tasks.filter(task => task.status === "cancelled").length;
  return [
    "Todos",
    ...(active ? [`${active} active`] : []),
    ...(pending ? [`${pending} pending`] : []),
    ...(completed ? [`${completed} completed`] : []),
    ...(cancelled ? [`${cancelled} cancelled`] : []),
  ].join(" · ");
}

function phaseTitle(phase: TodoPhase, phaseIndex: number, selected: boolean, theme: ThemeLike | undefined): string {
  const title = `${phaseIndex + 1}. ${phaseSummary(phase)}`;
  if (selected) return toolTitle(`  ${title}`, theme);
  return theme?.fg ? theme.fg("dim", `  ${title}`) : `  ${title}`;
}

function phaseSummary(phase: TodoPhase): string {
  const active = phase.tasks.filter(isActive).length;
  const pending = phase.tasks.filter(task => task.status === "pending").length;
  const completed = phase.tasks.filter(task => task.status === "completed").length;
  const cancelled = phase.tasks.filter(task => task.status === "cancelled").length;
  return [
    phase.name,
    ...(active ? [`${active} active`] : []),
    ...(pending ? [`${pending} pending`] : []),
    ...(completed ? [`${completed} completed`] : []),
    ...(cancelled ? [`${cancelled} cancelled`] : []),
  ].join(" · ");
}

function toolTitle(text: string, theme: ThemeLike | undefined): string {
  const bold = theme?.bold ? theme.bold(text) : text;
  return theme?.fg ? theme.fg("toolTitle", bold) : bold;
}

function visibleTasks(tasks: Todo[], maxVisible: number): DisplayTask[] {
  const ordered = tasks
    .map((task, taskIndex) => ({ ...task, taskIndex }))
    .filter(task => !isTerminal(task))
    .sort((left, right) => taskPriority(left) - taskPriority(right) || left.taskIndex - right.taskIndex);
  const active = ordered.filter(isActive);
  return active.length > maxVisible ? active : ordered.slice(0, maxVisible);
}

function taskLine(task: Todo, theme: ThemeLike | undefined, fallbackGlyphs = false, activeMarker?: string): string {
  const marker = isActive(task) && activeMarker ? activeMarker : todoGlyph(task.status, fallbackGlyphs);
  const color = task.status === "in_progress" ? "text" : task.status === "completed" ? "success" : "dim";
  const name = (task.status === "completed" || task.status === "cancelled") && theme?.strikethrough
    ? theme.strikethrough(task.name)
    : task.name;
  let line = `    ${marker} ${name}`;
  if (isActive(task) && theme?.bold) line = theme.bold(line);
  return theme?.fg ? theme.fg(color, line) : line;
}

function taskPriority(task: Todo): number {
  if (isActive(task)) return 0;
  if (task.status === "pending") return 1;
  return 2;
}

function selectPhase(phases: TodoPhase[]): number {
  const active = phases.findIndex(phase => phase.tasks.some(isActive));
  if (active >= 0) return active;
  return phases.findIndex(phase => phase.tasks.some(task => task.status === "pending"));
}

function terminalTaskSummary(tasks: Todo[]): string | undefined {
  const completed = tasks.filter(task => task.status === "completed").length;
  const cancelled = tasks.filter(task => task.status === "cancelled").length;
  const parts = [
    ...(completed ? [`${completed} complete ${completed === 1 ? "task" : "tasks"}`] : []),
    ...(cancelled ? [`${cancelled} cancelled ${cancelled === 1 ? "task" : "tasks"}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : undefined;
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
