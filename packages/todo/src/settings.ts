import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type TodoWidgetPlacement = "aboveEditor" | "belowEditor" | "off";
export type TodoToolVisibility = "all" | "set-only" | "none";

export interface TodoUiSettings {
  widgetPlacement: TodoWidgetPlacement;
  maxVisibleTasks: number;
  fallbackGlyphs: boolean;
  toolVisibility: TodoToolVisibility;
}

/** The portion of Pi's session context needed to load project-specific settings. */
export interface TodoSettingsContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

export interface TodoUiSettingsLoadResult {
  settings: TodoUiSettings;
  warning?: string;
}

export interface TodoUiSettingsStoreOptions {
  globalSettingsPath?: string;
  projectSettingsPath?: (cwd: string) => string;
}

export const DEFAULT_TODO_UI_SETTINGS: TodoUiSettings = {
  widgetPlacement: "aboveEditor",
  maxVisibleTasks: 5,
  fallbackGlyphs: false,
  toolVisibility: "set-only",
};

const WIDGET_PLACEMENTS = new Set<TodoWidgetPlacement>(["aboveEditor", "belowEditor", "off"]);
const TOOL_VISIBILITIES = new Set<TodoToolVisibility>(["all", "set-only", "none"]);

export function getTodoGlobalSettingsPath(): string {
  return join(getAgentDir(), "todo", "settings.json");
}

export function getTodoProjectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "todo", "settings.json");
}

/**
 * Loads global settings and, only for a trusted project, project-local overrides.
 * Pass the event handler's `ctx` directly to `load` or `loadTodoUiSettings`.
 */
export class TodoUiSettingsStore {
  private readonly globalSettingsPath: string;
  private readonly projectSettingsPath: (cwd: string) => string;

  constructor(options: TodoUiSettingsStoreOptions = {}) {
    this.globalSettingsPath = options.globalSettingsPath ?? getTodoGlobalSettingsPath();
    this.projectSettingsPath = options.projectSettingsPath ?? getTodoProjectSettingsPath;
  }

  async load(context?: TodoSettingsContext): Promise<TodoUiSettingsLoadResult> {
    const settings = cloneDefaults();
    const warnings: string[] = [];

    await applyFile(this.globalSettingsPath, settings, warnings);

    // Pi resolves trust before session handlers run. Never read project-controlled settings unless
    // that resolved context says the project is trusted.
    if (context && isTrusted(context)) {
      await applyFile(this.projectSettingsPath(context.cwd), settings, warnings);
    }

    return { settings, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) };
  }
}

/** Convenience API for loading settings from a Pi session/event context. */
export async function loadTodoUiSettings(context?: TodoSettingsContext): Promise<TodoUiSettingsLoadResult> {
  return new TodoUiSettingsStore().load(context);
}

/** Validates an object as a complete settings input, defaulting invalid or absent fields. */
export function normalizeTodoUiSettings(value: unknown): TodoUiSettingsLoadResult {
  const settings = cloneDefaults();
  const warnings: string[] = [];
  applySettings(value, settings, warnings);
  return { settings, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) };
}

async function applyFile(path: string, settings: TodoUiSettings, warnings: string[]): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`Could not read todo settings at ${path}; using available defaults.`);
    }
    return;
  }

  try {
    applySettings(JSON.parse(raw) as unknown, settings, warnings);
  } catch {
    warnings.push(`Invalid todo settings at ${path}; using available defaults.`);
  }
}

function applySettings(value: unknown, settings: TodoUiSettings, warnings: string[]): void {
  if (!isRecord(value)) {
    warnings.push("Invalid todo settings; using available defaults.");
    return;
  }

  if (value.widgetPlacement !== undefined) {
    if (WIDGET_PLACEMENTS.has(value.widgetPlacement as TodoWidgetPlacement)) {
      settings.widgetPlacement = value.widgetPlacement as TodoWidgetPlacement;
    } else {
      warnings.push("Invalid todo widgetPlacement; ignoring value.");
    }
  }
  if (value.maxVisibleTasks !== undefined) {
    if (Number.isInteger(value.maxVisibleTasks) && (value.maxVisibleTasks as number) > 0) {
      settings.maxVisibleTasks = value.maxVisibleTasks as number;
    } else {
      warnings.push("Invalid todo maxVisibleTasks; ignoring value.");
    }
  }
  if (value.fallbackGlyphs !== undefined) {
    if (typeof value.fallbackGlyphs === "boolean") {
      settings.fallbackGlyphs = value.fallbackGlyphs;
    } else {
      warnings.push("Invalid todo fallbackGlyphs; ignoring value.");
    }
  }
  if (value.toolVisibility !== undefined) {
    if (TOOL_VISIBILITIES.has(value.toolVisibility as TodoToolVisibility)) {
      settings.toolVisibility = value.toolVisibility as TodoToolVisibility;
    } else {
      warnings.push("Invalid todo toolVisibility; ignoring value.");
    }
  }
}

function cloneDefaults(): TodoUiSettings {
  return { ...DEFAULT_TODO_UI_SETTINGS };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTrusted(context: TodoSettingsContext): boolean {
  try {
    return context.isProjectTrusted();
  } catch {
    return false;
  }
}
