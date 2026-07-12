import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { countTodos, formatTodoSummary, todoTasks, type PhasedTodo } from "./format.js";
import { todoGlyph } from "./glyphs.js";
import type { TodoParams } from "./schema.js";
import { todoAddressKey } from "./state.js";
import type { Todo, TodoAddress, TodoPhase, TodoState, TodoToolDetails } from "./types.js";

type ThemeLike = Partial<Pick<Theme, "fg" | "bold" | "strikethrough">>;
type ThemeColor = Parameters<Theme["fg"]>[0];

export type TodoRendererOptions = { fallbackGlyphs?: boolean };

export function renderCall(params: TodoParams | undefined, theme?: ThemeLike): Text {
  const action = params?.action;
  const label = typeof action === "string" && action ? `todo ${action}` : "todo";
  return new Text(paint(theme, "toolTitle", label), 0, 0);
}

export function renderResult(
  result: { details?: TodoToolDetails; content?: readonly { type?: string; text?: string }[] },
  options: { expanded?: boolean } = {},
  theme?: ThemeLike,
  rendererOptions: TodoRendererOptions = {},
): Text {
  const state = result.details?.state;
  if (!state) return new Text(fallbackText(result), 0, 0);

  const tasks = todoTasks(state);
  if (tasks.length === 0 && state.phases.length === 0) return new Text(paint(theme, "muted", "No todo tasks."), 0, 0);

  const counts = countTodos(state);
  const header = todoHeader(counts);
  if (options.expanded !== true) return new Text(collapsedText(header, tasks, theme, rendererOptions), 0, 0);

  const changed = new Set((result.details?.changedTasks ?? []).map(addressKey));
  const selectedPhase = selectedPhaseIndex(state.phases);
  const lines = [toolTitle(todoSummary(tasks), theme)];
  for (const [index, phase] of state.phases.entries()) {
    const heading = `  ${index + 1}. ${phaseSummary(phase)}`;
    lines.push(index === selectedPhase ? toolTitle(heading, theme) : paint(theme, "dim", heading));
    for (const task of orderedTasks(phase.tasks)) {
      lines.push(renderTask(phase.name, task, changed, theme, rendererOptions));
    }
  }
  return new Text(lines.join("\n"), 0, 0);
}

export function formatResultText(details: TodoToolDetails | undefined): string {
  return formatTodoSummary(details?.state);
}

function todoHeader(counts: ReturnType<typeof countTodos>, title = "Todo"): string {
  return [
    `${title} · ${counts.open} open`,
    ...(counts.completed ? [`${counts.completed} completed`] : []),
    ...(counts.cancelled ? [`${counts.cancelled} cancelled`] : []),
  ].join(" · ");
}

function collapsedText(header: string, tasks: PhasedTodo[], theme: ThemeLike | undefined, options: TodoRendererOptions): string {
  const active = tasks.find((task) => task.status === "in_progress");
  const activeText = active ? `Active: ${todoGlyph(active.status, options.fallbackGlyphs)} ${active.name}` : undefined;
  return [paint(theme, "muted", header), ...(activeText ? [paint(theme, "warning", activeText)] : []), paint(theme, "dim", "↵ expand")].join(" · ");
}

function todoSummary(tasks: Todo[]): string {
  const active = tasks.filter((task) => task.status === "in_progress").length;
  const pending = tasks.filter((task) => task.status === "pending").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  return [
    "Todos",
    ...(active ? [`${active} active`] : []),
    ...(pending ? [`${pending} pending`] : []),
    ...(completed ? [`${completed} completed`] : []),
    ...(cancelled ? [`${cancelled} cancelled`] : []),
  ].join(" · ");
}

function phaseSummary(phase: TodoPhase): string {
  const active = phase.tasks.filter((task) => task.status === "in_progress").length;
  const pending = phase.tasks.filter((task) => task.status === "pending").length;
  const completed = phase.tasks.filter((task) => task.status === "completed").length;
  const cancelled = phase.tasks.filter((task) => task.status === "cancelled").length;
  return [
    phase.name,
    ...(active ? [`${active} active`] : []),
    ...(pending ? [`${pending} pending`] : []),
    ...(completed ? [`${completed} completed`] : []),
    ...(cancelled ? [`${cancelled} cancelled`] : []),
  ].join(" · ");
}

function selectedPhaseIndex(phases: TodoPhase[]): number {
  const active = phases.findIndex((phase) => phase.tasks.some((task) => task.status === "in_progress"));
  if (active !== -1) return active;
  return phases.findIndex((phase) => phase.tasks.some((task) => task.status === "pending"));
}

function orderedTasks(tasks: Todo[]): Todo[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => taskPriority(left.task) - taskPriority(right.task) || left.index - right.index)
    .map(({ task }) => task);
}

function taskPriority(task: Todo): number {
  if (task.status === "in_progress") return 0;
  if (task.status === "pending") return 1;
  return 2;
}

function renderTask(phase: string, task: Todo, changed: Set<string>, theme: ThemeLike | undefined, options: TodoRendererOptions): string {
  const text = isTerminal(task) && theme?.strikethrough ? theme.strikethrough(task.name) : task.name;
  let line = `    ${todoGlyph(task.status, options.fallbackGlyphs)} ${text}`;
  if ((task.status === "in_progress" || changed.has(todoAddressKey(phase, task.name))) && theme?.bold) line = theme.bold(line);
  return paint(theme, statusColor(task.status), line);
}

function isTerminal(task: Todo): boolean {
  return task.status === "completed" || task.status === "cancelled";
}

function addressKey(address: TodoAddress): string {
  return todoAddressKey(address.phase, address.task);
}

function statusColor(status: string): ThemeColor {
  if (status === "completed") return "success";
  if (status === "in_progress") return "text";
  return "dim";
}

function toolTitle(text: string, theme: ThemeLike | undefined): string {
  const title = theme?.bold ? theme.bold(text) : text;
  return paint(theme, "toolTitle", title);
}

function paint(theme: ThemeLike | undefined, color: ThemeColor, text: string): string {
  return theme?.fg ? theme.fg(color, text) : text;
}

function fallbackText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return result.content?.find((part) => part.type === "text")?.text || "No todo tasks.";
}
