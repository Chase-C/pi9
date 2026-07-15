import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { TODO_SEPARATOR_GLYPH, TODO_TRUNCATION_GLYPH, WORKING_SPINNER_FRAMES, todoGlyph } from "./glyphs.js";
import { currentTodoPhaseIndex } from "./state.js";
import { isTerminalTodo, todoTaskPriority, type Todo, type TodoPhase, type TodoState } from "./types.js";

export type TodoWidgetLayoutOptions = {
  maxVisible?: number;
  fallbackGlyphs?: boolean;
  workingMarker?: string;
};

type ThemeLike = Partial<Pick<Theme, "bold" | "fg" | "strikethrough">>;

type DisplayTask = Todo & { taskIndex: number };

/** Produces compact widget rows constrained to the supplied display width. */
export function renderTodoWidgetLines(
  state: TodoState | undefined,
  theme: ThemeLike | undefined,
  width: number,
  options: TodoWidgetLayoutOptions = {},
): string[] {
  const safeWidth = Math.max(1, Math.floor(width) || 1);
  const phases = state?.phases ?? [];
  const currentPhaseIndex = currentTodoPhaseIndex(phases);
  const selectedPhaseIndex = currentPhaseIndex >= 0
    ? currentPhaseIndex
    : lastNonEmptyPhaseIndex(phases);
  if (selectedPhaseIndex < 0) return [];
  const selectedPhase = phases[selectedPhaseIndex];
  const maxVisible = boundedMaxVisible(options.maxVisible);
  const selectedTasks = visibleTasks(selectedPhase.tasks, maxVisible);
  const lines: string[] = [fit(toolTitle("Todos", theme), safeWidth)];

  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const phase = phases[phaseIndex];
    const selected = phaseIndex === selectedPhaseIndex;
    lines.push(fit(phaseTitle(phase, phaseIndex, selected, theme), safeWidth));

    if (selected) {
      for (const task of selectedTasks) {
        lines.push(fit(taskLine(task, theme, options.fallbackGlyphs), safeWidth));
      }
      const openTasks = phase.tasks.filter(task => !isTerminalTodo(task));
      const hidden = openTasks.length - selectedTasks.length;
      if (hidden > 0) lines.push(fit(`    +${hidden} more`, safeWidth));
      const terminalSummary = terminalTaskSummary(phase.tasks);
      if (terminalSummary) {
        const line = `    + ${terminalSummary}`;
        lines.push(fit(theme?.fg ? theme.fg("dim", line) : line, safeWidth));
      }
    }
  }

  if (state?.workingOn) {
    lines.push("");
    const working = `${options.workingMarker ?? WORKING_SPINNER_FRAMES[0]} ${state.workingOn}`;
    const text = theme?.fg ? theme.fg("muted", working) : working;
    lines.push(fit(`  ${text}`, safeWidth));
  }

  return lines.map((line) => line ? fit(` ${line}`, safeWidth) : line);
}

function lastNonEmptyPhaseIndex(phases: readonly TodoPhase[]): number {
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    if (phases[index].tasks.length > 0) return index;
  }
  return -1;
}

function boundedMaxVisible(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.floor(value));
}

function phaseTitle(phase: TodoPhase, phaseIndex: number, selected: boolean, theme: ThemeLike | undefined): string {
  const title = `  ${phaseIndex + 1}. ${phase.name}`;
  const terminal = phase.tasks.filter(isTerminalTodo).length;
  const progress = `${TODO_SEPARATOR_GLYPH} ${terminal}/${phase.tasks.length}`;
  if (!selected) {
    const line = `${title} ${progress}`;
    return theme?.fg ? theme.fg("dim", line) : line;
  }
  const dimProgress = theme?.fg ? theme.fg("dim", progress) : progress;
  return `${toolTitle(title, theme)} ${dimProgress}`;
}

function toolTitle(text: string, theme: ThemeLike | undefined): string {
  const bold = theme?.bold ? theme.bold(text) : text;
  return theme?.fg ? theme.fg("toolTitle", bold) : bold;
}

function visibleTasks(tasks: readonly Todo[], maxVisible: number): DisplayTask[] {
  const ordered = tasks
    .map((task, taskIndex) => ({ ...task, taskIndex }))
    .filter(task => !isTerminalTodo(task))
    .sort((left, right) => todoTaskPriority(left) - todoTaskPriority(right) || left.taskIndex - right.taskIndex);
  const active = ordered.filter(isActive);
  return active.length > maxVisible ? active : ordered.slice(0, maxVisible);
}

function taskLine(task: Todo, theme: ThemeLike | undefined, fallbackGlyphs = false): string {
  const marker = todoGlyph(task.status, fallbackGlyphs);
  const color = task.status === "in_progress" ? "text" : task.status === "completed" ? "success" : "dim";
  const name = isTerminalTodo(task) && theme?.strikethrough
    ? theme.strikethrough(task.name)
    : task.name;
  const line = `    ${marker} ${name}`;
  if (!theme?.fg) return line;
  if (task.status === "in_progress") {
    return `${theme.fg("dim", `    ${marker}`)} ${theme.fg("text", name)}`;
  }
  return theme.fg(color, line);
}

function terminalTaskSummary(tasks: readonly Todo[]): string | undefined {
  const completed = tasks.filter(task => task.status === "completed").length;
  const cancelled = tasks.filter(task => task.status === "cancelled").length;
  const parts = [
    ...(completed ? [`${completed} complete ${completed === 1 ? "task" : "tasks"}`] : []),
    ...(cancelled ? [`${cancelled} cancelled ${cancelled === 1 ? "task" : "tasks"}`] : []),
  ];
  return parts.length > 0 ? parts.join(` ${TODO_SEPARATOR_GLYPH} `) : undefined;
}

function isActive(task: Todo): boolean {
  return task.status === "in_progress";
}

function fit(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, TODO_TRUNCATION_GLYPH);
}
