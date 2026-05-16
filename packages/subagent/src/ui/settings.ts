import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type WidgetPlacement = "belowEditor" | "aboveEditor" | "off";
export type ProjectAgentsStrategy = "nearest" | "off";
export type DuplicateNamePolicy = "projectOverridesUser" | "userOverridesProject";
export type BackgroundNotifyMode = "end-of-turn" | "next-tool-call" | "none";

export interface SubagentUiSettings {
  widgetPlacement: WidgetPlacement;
}

export interface SubagentRuntimeSettings {
  maxTasksPerRun: number;
  /**
   * Tree-wide cap on concurrently running subagents. A single shared task queue spans every
   * parent/child level within one Pi process, so this value bounds the total in-flight count
   * across the whole recursive tree rather than per-manager or per-parent.
   */
  maxConcurrentSubagents: number;
  defaultResumable: boolean;
  backgroundNotify: BackgroundNotifyMode;
}

export interface SubagentAgentDiscoverySettings {
  includeUserAgents: boolean;
  includeProjectAgents: boolean;
  projectAgentsStrategy: ProjectAgentsStrategy;
  agentFileExtensions: string[];
  duplicateNamePolicy: DuplicateNamePolicy;
  warnOnInvalidAgents: boolean;
}

export interface SubagentDisplaySettings {
  promptPreviewLength: number;
  messageSnippetLength: number;
  outputSnippetLength: number;
  outputSnippetMaxLines: number;
  resumeMessageSnippetLength: number;
  toolCallLabelMaxLength: number;
  collapsedAgentListLimit: number;
  collapsedDescriptionLength: number;
  widgetShowRetainedSessions: boolean;
}

export interface SubagentSettings extends SubagentUiSettings {
  runtime: SubagentRuntimeSettings;
  agentDiscovery: SubagentAgentDiscoverySettings;
  display: SubagentDisplaySettings;
}

export const DEFAULT_SUBAGENT_UI_SETTINGS: SubagentUiSettings = {
  widgetPlacement: "belowEditor",
};

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
  ...DEFAULT_SUBAGENT_UI_SETTINGS,
  runtime: {
    maxTasksPerRun: 8,
    maxConcurrentSubagents: 4,
    defaultResumable: false,
    backgroundNotify: "end-of-turn",
  },
  agentDiscovery: {
    includeUserAgents: true,
    includeProjectAgents: true,
    projectAgentsStrategy: "nearest",
    agentFileExtensions: [".md"],
    duplicateNamePolicy: "projectOverridesUser",
    warnOnInvalidAgents: false,
  },
  display: {
    promptPreviewLength: 120,
    messageSnippetLength: 200,
    outputSnippetLength: 400,
    outputSnippetMaxLines: 8,
    resumeMessageSnippetLength: 80,
    toolCallLabelMaxLength: 60,
    collapsedAgentListLimit: 8,
    collapsedDescriptionLength: 100,
    widgetShowRetainedSessions: true,
  },
};

export type SubagentUiSettingsLoadResult = {
  settings: SubagentSettings;
  warning?: string;
};

const WIDGET_PLACEMENTS = new Set<WidgetPlacement>(["belowEditor", "aboveEditor", "off"]);
const PROJECT_AGENTS_STRATEGIES = new Set<ProjectAgentsStrategy>(["nearest", "off"]);
const DUPLICATE_NAME_POLICIES = new Set<DuplicateNamePolicy>(["projectOverridesUser", "userOverridesProject"]);
const BACKGROUND_NOTIFY_MODES = new Set<BackgroundNotifyMode>(["end-of-turn", "next-tool-call", "none"]);

export class SubagentUiSettingsStore {
  constructor(readonly settingsPath = join(getAgentDir(), "subagent", "settings.json")) { }

  async load(): Promise<SubagentUiSettingsLoadResult> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizeSettings(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { settings: cloneDefaults() };
      }
      return {
        settings: cloneDefaults(),
        warning: `Invalid subagent settings at ${this.settingsPath}; using defaults.`,
      };
    }
  }

  async save(settings: SubagentSettings | SubagentUiSettings): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, `${JSON.stringify(normalizeSettings(settings).settings, null, 2)}\n`, "utf8");
  }
}

export function normalizeSettings(value: unknown): SubagentUiSettingsLoadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      settings: cloneDefaults(),
      warning: "Invalid subagent settings; using defaults.",
    };
  }

  const record = value as Record<string, unknown>;
  const settings = cloneDefaults();
  const warnings: string[] = [];

  const widgetPlacement = record.widgetPlacement;
  if (widgetPlacement !== undefined) {
    if (WIDGET_PLACEMENTS.has(widgetPlacement as WidgetPlacement)) settings.widgetPlacement = widgetPlacement as WidgetPlacement;
    else warnings.push("Invalid subagent widgetPlacement; using belowEditor.");
  }

  const runtime = objectValue(record.runtime);
  if (runtime) {
    assignPositiveInt(runtime, "maxTasksPerRun", value => { settings.runtime.maxTasksPerRun = value; }, warnings);
    assignPositiveInt(runtime, "maxConcurrentSubagents", value => { settings.runtime.maxConcurrentSubagents = value; }, warnings);
    assignBoolean(runtime, "defaultResumable", value => { settings.runtime.defaultResumable = value; }, warnings);
    assignEnum(runtime, "backgroundNotify", BACKGROUND_NOTIFY_MODES, value => { settings.runtime.backgroundNotify = value; }, warnings);
  }

  const discovery = objectValue(record.agentDiscovery);
  if (discovery) {
    assignBoolean(discovery, "includeUserAgents", value => { settings.agentDiscovery.includeUserAgents = value; }, warnings);
    assignBoolean(discovery, "includeProjectAgents", value => { settings.agentDiscovery.includeProjectAgents = value; }, warnings);
    assignEnum(discovery, "projectAgentsStrategy", PROJECT_AGENTS_STRATEGIES, value => { settings.agentDiscovery.projectAgentsStrategy = value; }, warnings);
    assignEnum(discovery, "duplicateNamePolicy", DUPLICATE_NAME_POLICIES, value => { settings.agentDiscovery.duplicateNamePolicy = value; }, warnings);
    assignBoolean(discovery, "warnOnInvalidAgents", value => { settings.agentDiscovery.warnOnInvalidAgents = value; }, warnings);
    const extensions = discovery.agentFileExtensions;
    if (extensions !== undefined) {
      if (Array.isArray(extensions) && extensions.every(item => typeof item === "string" && item.startsWith(".") && item.length > 1)) {
        settings.agentDiscovery.agentFileExtensions = [...new Set(extensions as string[])];
      } else {
        warnings.push("Invalid subagent agentDiscovery.agentFileExtensions; using .md.");
      }
    }
  }

  const display = objectValue(record.display);
  if (display) {
    assignPositiveInt(display, "promptPreviewLength", value => { settings.display.promptPreviewLength = value; }, warnings);
    assignPositiveInt(display, "messageSnippetLength", value => { settings.display.messageSnippetLength = value; }, warnings);
    assignPositiveInt(display, "outputSnippetLength", value => { settings.display.outputSnippetLength = value; }, warnings);
    assignPositiveInt(display, "outputSnippetMaxLines", value => { settings.display.outputSnippetMaxLines = value; }, warnings);
    assignPositiveInt(display, "resumeMessageSnippetLength", value => { settings.display.resumeMessageSnippetLength = value; }, warnings);
    assignPositiveInt(display, "toolCallLabelMaxLength", value => { settings.display.toolCallLabelMaxLength = value; }, warnings);
    assignPositiveInt(display, "collapsedAgentListLimit", value => { settings.display.collapsedAgentListLimit = value; }, warnings);
    assignPositiveInt(display, "collapsedDescriptionLength", value => { settings.display.collapsedDescriptionLength = value; }, warnings);
    assignBoolean(display, "widgetShowRetainedSessions", value => { settings.display.widgetShowRetainedSessions = value; }, warnings);
  }

  return { settings, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
}

function cloneDefaults(): SubagentSettings {
  return {
    widgetPlacement: DEFAULT_SUBAGENT_SETTINGS.widgetPlacement,
    runtime: { ...DEFAULT_SUBAGENT_SETTINGS.runtime },
    agentDiscovery: {
      ...DEFAULT_SUBAGENT_SETTINGS.agentDiscovery,
      agentFileExtensions: [...DEFAULT_SUBAGENT_SETTINGS.agentDiscovery.agentFileExtensions],
    },
    display: { ...DEFAULT_SUBAGENT_SETTINGS.display },
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function assignPositiveInt(record: Record<string, unknown>, field: string, set: (value: number) => void, warnings: string[]) {
  const value = record[field];
  if (value === undefined) return;
  if (Number.isInteger(value) && (value as number) > 0) set(value as number);
  else warnings.push(`Invalid subagent ${field}; using default.`);
}

function assignBoolean(record: Record<string, unknown>, field: string, set: (value: boolean) => void, warnings: string[]) {
  const value = record[field];
  if (value === undefined) return;
  if (typeof value === "boolean") set(value);
  else warnings.push(`Invalid subagent ${field}; using default.`);
}

function assignEnum<T extends string>(record: Record<string, unknown>, field: string, allowed: Set<T>, set: (value: T) => void, warnings: string[]) {
  const value = record[field];
  if (value === undefined) return;
  if (allowed.has(value as T)) set(value as T);
  else warnings.push(`Invalid subagent ${field}; using default.`);
}
