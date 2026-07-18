import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type WidgetPlacement = "belowEditor" | "aboveEditor" | "off";
export type WidgetLayout = "auto" | "columns" | "stacked";
export type ProjectAgentsStrategy = "nearest" | "off";
export type DuplicateNamePolicy = "projectOverridesUser" | "userOverridesProject";
export type CompletionNotifyMode = "auto" | "steer" | "none";

export interface SubagentUiSettings {
  widgetPlacement: WidgetPlacement;
  widgetLayout: WidgetLayout;
}

export interface SubagentRuntimeSettings {
  maxTasksPerRun: number;
  /**
   * Tree-wide cap on concurrently running subagents. A single shared task queue spans every
   * parent/child level within one Pi process, so this value bounds the total in-flight count
   * across the whole recursive tree rather than per-manager or per-parent.
   */
  maxConcurrentSubagents: number;
  /** Maximum number of conversations stored by the runtime. */
  maxConversations: number;
  completionNotify: CompletionNotifyMode;
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
  toolCallLabelMaxLength: number;
  toolInputSummaryLength: number;
  collapsedAgentListLimit: number;
  collapsedDescriptionLength: number;
  /** Max rows per widget section before a +N more overflow line. */
  widgetMaxRowsPerSection: number;
}

export interface SubagentSettings extends SubagentUiSettings {
  runtime: SubagentRuntimeSettings;
  agentDiscovery: SubagentAgentDiscoverySettings;
  display: SubagentDisplaySettings;
}

export const DEFAULT_SUBAGENT_UI_SETTINGS: SubagentUiSettings = {
  widgetPlacement: "belowEditor",
  widgetLayout: "auto",
};

export function createDefaultSubagentSettings(): SubagentSettings {
  return {
    ...DEFAULT_SUBAGENT_UI_SETTINGS,
    runtime: {
      maxTasksPerRun: 8,
      maxConcurrentSubagents: 4,
      maxConversations: 100,
      completionNotify: "auto",
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
      toolCallLabelMaxLength: 60,
      toolInputSummaryLength: 80,
      collapsedAgentListLimit: 8,
      collapsedDescriptionLength: 100,
      widgetMaxRowsPerSection: 6,
    },
  };
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = createDefaultSubagentSettings();

export type SubagentSettingsLoadResult = {
  settings: SubagentSettings;
  warning?: string;
};

export type SubagentSettingsSaveInput = Partial<SubagentUiSettings> | SubagentSettings;

const WIDGET_PLACEMENTS = new Set<WidgetPlacement>(["belowEditor", "aboveEditor", "off"]);
const WIDGET_LAYOUTS = new Set<WidgetLayout>(["auto", "columns", "stacked"]);
const PROJECT_AGENTS_STRATEGIES = new Set<ProjectAgentsStrategy>(["nearest", "off"]);
const DUPLICATE_NAME_POLICIES = new Set<DuplicateNamePolicy>(["projectOverridesUser", "userOverridesProject"]);
const COMPLETION_NOTIFY_MODES = new Set<CompletionNotifyMode>(["auto", "steer", "none"]);

export class SubagentSettingsStore {
  constructor(readonly settingsPath = join(getAgentDir(), "subagent", "settings.json")) { }

  async load(): Promise<SubagentSettingsLoadResult> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizeSettings(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { settings: createDefaultSubagentSettings() };
      }
      return {
        settings: createDefaultSubagentSettings(),
        warning: `Invalid subagent settings at ${this.settingsPath}; using defaults.`,
      };
    }
  }

  async save(settings: SubagentSettingsSaveInput): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, `${JSON.stringify(normalizeSettings(settings).settings, null, 2)}\n`, "utf8");
  }
}

export function normalizeSettings(value: unknown): SubagentSettingsLoadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      settings: createDefaultSubagentSettings(),
      warning: "Invalid subagent settings; using defaults.",
    };
  }

  const record = value as Record<string, unknown>;
  const settings = createDefaultSubagentSettings();
  const warnings: string[] = [];

  const widgetPlacement = record.widgetPlacement;
  if (widgetPlacement !== undefined) {
    if (WIDGET_PLACEMENTS.has(widgetPlacement as WidgetPlacement)) settings.widgetPlacement = widgetPlacement as WidgetPlacement;
    else warnings.push("Invalid subagent widgetPlacement; using belowEditor.");
  }

  assignEnum(record, "widgetLayout", WIDGET_LAYOUTS, value => { settings.widgetLayout = value; }, warnings);

  const runtime = objectValue(record.runtime);
  if (runtime) {
    assignPositiveInt(runtime, "maxTasksPerRun", value => { settings.runtime.maxTasksPerRun = value; }, warnings);
    assignPositiveInt(runtime, "maxConcurrentSubagents", value => { settings.runtime.maxConcurrentSubagents = value; }, warnings);
    assignPositiveInt(runtime, "maxConversations", value => { settings.runtime.maxConversations = value; }, warnings);
    assignEnum(runtime, "completionNotify", COMPLETION_NOTIFY_MODES, value => { settings.runtime.completionNotify = value; }, warnings);
    warnRemoved(runtime, "defaultRetainConversation", warnings);
    warnRemoved(runtime, "backgroundNotify", warnings);
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
    assignPositiveInt(display, "toolCallLabelMaxLength", value => { settings.display.toolCallLabelMaxLength = value; }, warnings);
    assignPositiveInt(display, "toolInputSummaryLength", value => { settings.display.toolInputSummaryLength = value; }, warnings);
    assignPositiveInt(display, "collapsedAgentListLimit", value => { settings.display.collapsedAgentListLimit = value; }, warnings);
    assignPositiveInt(display, "collapsedDescriptionLength", value => { settings.display.collapsedDescriptionLength = value; }, warnings);
    assignPositiveInt(display, "widgetMaxRowsPerSection", value => { settings.display.widgetMaxRowsPerSection = value; }, warnings);
    warnRemoved(display, "widgetShowRetainedSessions", warnings);
    warnRemoved(display, "widgetShowForeground", warnings);
  }

  return { settings, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
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

function warnRemoved(record: Record<string, unknown>, field: string, warnings: string[]) {
  if (record[field] !== undefined) warnings.push(`Removed subagent ${field} setting ignored.`);
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
