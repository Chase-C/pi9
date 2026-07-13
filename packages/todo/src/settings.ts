import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type TodoWidgetPlacement = "aboveEditor" | "belowEditor" | "off";
export type TodoToolVisibility = "all" | "set-only" | "none";

export interface TodoSettings {
  widgetPlacement: TodoWidgetPlacement;
  maxVisibleTasks: number;
  fallbackGlyphs: boolean;
  toolVisibility: TodoToolVisibility;
  dynamicReminders: boolean;
  reminderMinTurns: number;
  reminderMaxTurns: number;
  reminderOutputTokens: number;
  reminderMaxPerRun: number;
}

export interface TodoSettingsContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

export interface TodoSettingsLoadResult {
  settings: TodoSettings;
  warning?: string;
}

export interface TodoSettingsSourceOptions {
  globalSettingsPath?: string;
  projectSettingsPath?: (cwd: string) => string;
}

export const DEFAULT_TODO_SETTINGS: TodoSettings = {
  widgetPlacement: "aboveEditor",
  maxVisibleTasks: 5,
  fallbackGlyphs: false,
  toolVisibility: "set-only",
  dynamicReminders: true,
  reminderMinTurns: 4,
  reminderMaxTurns: 8,
  reminderOutputTokens: 16000,
  reminderMaxPerRun: 2,
};

const WIDGET_PLACEMENTS = new Set<TodoWidgetPlacement>(["aboveEditor", "belowEditor", "off"]);
const TOOL_VISIBILITIES = new Set<TodoToolVisibility>(["all", "set-only", "none"]);

type PositiveIntegerSetting = "reminderMinTurns" | "reminderMaxTurns" | "reminderOutputTokens" | "reminderMaxPerRun";

export function getTodoGlobalSettingsPath(): string {
  return join(getAgentDir(), "todo", "settings.json");
}

export function getTodoProjectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "todo", "settings.json");
}

export async function loadTodoSettings(
  context?: TodoSettingsContext,
  options: TodoSettingsSourceOptions = {},
): Promise<TodoSettingsLoadResult> {
  const settings = defaultTodoSettings();
  const warnings: string[] = [];
  const globalPath = options.globalSettingsPath ?? getTodoGlobalSettingsPath();

  await applyFile(globalPath, settings, warnings);
  if (context && isTrusted(context)) {
    const projectPath = options.projectSettingsPath ?? getTodoProjectSettingsPath;
    await applyFile(projectPath(context.cwd), settings, warnings);
  }

  return loadResult(settings, warnings);
}

export function normalizeTodoSettings(value: unknown): TodoSettingsLoadResult {
  const settings = defaultTodoSettings();
  const warnings: string[] = [];
  applySettings(value, settings, warnings);
  return loadResult(settings, warnings);
}

async function applyFile(path: string, settings: TodoSettings, warnings: string[]): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`Could not read todo settings at ${path}; keeping existing settings.`);
    }
    return;
  }

  try {
    applySettings(JSON.parse(raw) as unknown, settings, warnings);
  } catch {
    warnings.push(`Invalid todo settings at ${path}; keeping existing settings.`);
  }
}

function applySettings(value: unknown, settings: TodoSettings, warnings: string[]): void {
  if (!isRecord(value)) {
    warnings.push("Invalid todo settings; using defaults.");
    return;
  }

  if (value.widgetPlacement !== undefined) {
    if (isSetMember(WIDGET_PLACEMENTS, value.widgetPlacement)) settings.widgetPlacement = value.widgetPlacement;
    else warnings.push("Invalid todo widgetPlacement; ignoring value.");
  }
  if (value.maxVisibleTasks !== undefined) {
    if (isPositiveInteger(value.maxVisibleTasks)) settings.maxVisibleTasks = value.maxVisibleTasks;
    else warnings.push("Invalid todo maxVisibleTasks; ignoring value.");
  }
  if (value.fallbackGlyphs !== undefined) {
    if (typeof value.fallbackGlyphs === "boolean") settings.fallbackGlyphs = value.fallbackGlyphs;
    else warnings.push("Invalid todo fallbackGlyphs; ignoring value.");
  }
  if (value.toolVisibility !== undefined) {
    if (isSetMember(TOOL_VISIBILITIES, value.toolVisibility)) settings.toolVisibility = value.toolVisibility;
    else warnings.push("Invalid todo toolVisibility; ignoring value.");
  }
  if (value.dynamicReminders !== undefined) {
    if (typeof value.dynamicReminders === "boolean") settings.dynamicReminders = value.dynamicReminders;
    else warnings.push("Invalid todo dynamicReminders; ignoring value.");
  }

  const priorTurnRange = [settings.reminderMinTurns, settings.reminderMaxTurns] as const;
  applyPositiveInteger(value, settings, warnings, "reminderMinTurns");
  applyPositiveInteger(value, settings, warnings, "reminderMaxTurns");
  if (settings.reminderMaxTurns < settings.reminderMinTurns) {
    [settings.reminderMinTurns, settings.reminderMaxTurns] = priorTurnRange;
    warnings.push("Invalid todo reminderMaxTurns; must be at least reminderMinTurns; ignoring reminder turn range.");
  }
  applyPositiveInteger(value, settings, warnings, "reminderOutputTokens");
  applyPositiveInteger(value, settings, warnings, "reminderMaxPerRun");
}

function applyPositiveInteger(
  value: Record<string, unknown>,
  settings: TodoSettings,
  warnings: string[],
  field: PositiveIntegerSetting,
): void {
  const candidate = value[field];
  if (candidate === undefined) return;
  if (isPositiveInteger(candidate)) settings[field] = candidate;
  else warnings.push(`Invalid todo ${field}; ignoring value.`);
}

function defaultTodoSettings(): TodoSettings {
  return { ...DEFAULT_TODO_SETTINGS };
}

function loadResult(settings: TodoSettings, warnings: string[]): TodoSettingsLoadResult {
  return { settings, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isSetMember<T extends string>(values: ReadonlySet<T>, value: unknown): value is T {
  return typeof value === "string" && values.has(value as T);
}

function isTrusted(context: TodoSettingsContext): boolean {
  try {
    return context.isProjectTrusted();
  } catch {
    return false;
  }
}
