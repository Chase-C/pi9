import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MAX_TIMEOUT_MS = 2_147_483_647;

export type TimeoutOnInput = "never-reset" | "reset" | "cancel";

export interface AskSettings {
  timeoutMs: number;
  timeoutOnInput: TimeoutOnInput;
}

export const DEFAULT_ASK_SETTINGS: AskSettings = {
  timeoutMs: 300_000,
  timeoutOnInput: "reset",
};

export type AskSettingsLoadResult = {
  settings: AskSettings;
  warning?: string;
};

const TIMEOUT_ON_INPUT_VALUES = new Set<TimeoutOnInput>(["never-reset", "reset", "cancel"]);

export class AskSettingsStore {
  constructor(readonly settingsPath = join(getAgentDir(), "ask", "settings.json")) {}

  async load(): Promise<AskSettingsLoadResult> {
    try {
      return normalizeAskSettings(JSON.parse(await readFile(this.settingsPath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { settings: { ...DEFAULT_ASK_SETTINGS } };
      }
      return {
        settings: { ...DEFAULT_ASK_SETTINGS },
        warning: `Invalid ask settings at ${this.settingsPath}; using defaults.`,
      };
    }
  }
}

export function normalizeAskSettings(value: unknown): AskSettingsLoadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      settings: { ...DEFAULT_ASK_SETTINGS },
      warning: "Invalid ask settings; using defaults.",
    };
  }

  const record = value as Record<string, unknown>;
  const settings = { ...DEFAULT_ASK_SETTINGS };
  const warnings: string[] = [];

  if (record.timeoutMs !== undefined) {
    if (Number.isInteger(record.timeoutMs) && (record.timeoutMs as number) > 0 && (record.timeoutMs as number) <= MAX_TIMEOUT_MS) {
      settings.timeoutMs = record.timeoutMs as number;
    } else {
      warnings.push("Invalid ask timeoutMs; using 300000.");
    }
  }

  if (record.timeoutOnInput !== undefined) {
    if (TIMEOUT_ON_INPUT_VALUES.has(record.timeoutOnInput as TimeoutOnInput)) {
      settings.timeoutOnInput = record.timeoutOnInput as TimeoutOnInput;
    } else {
      warnings.push("Invalid ask timeoutOnInput; using reset.");
    }
  }

  return { settings, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
}

interface AskSettingsLoadContext {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

export async function loadAskSettings(
  ctx: AskSettingsLoadContext,
  settingsStore: Pick<AskSettingsStore, "load">,
): Promise<AskSettings> {
  try {
    const result = await settingsStore.load();
    if (result.warning) notifyWarning(ctx, result.warning);
    return result.settings;
  } catch (error) {
    const warning = `Failed to load ask settings; using defaults. ${error instanceof Error ? error.message : String(error)}`;
    notifyWarning(ctx, warning);
    return { ...DEFAULT_ASK_SETTINGS };
  }
}

function notifyWarning(ctx: AskSettingsLoadContext, warning: string): void {
  try {
    if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(warning, "warning");
    else console.warn(warning);
  } catch {}
}
