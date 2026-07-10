import { loadSubagentSettings, type SubagentSettingsLoadContext } from "../config/load-settings.js";
import type { SubagentSettings, SubagentSettingsStore, SubagentAgentDiscoverySettings } from "../config/settings.js";

export interface PrepareSubagentRuntimeContext extends SubagentSettingsLoadContext {
  cwd: string;
}

export interface PrepareSubagentRuntimeAgentManager {
  configure?(options: { maxRunning?: number }): void;
}

export interface PrepareSubagentRuntimeAgentRegistry {
  reload(cwd: string, options: {
    discovery?: Partial<SubagentAgentDiscoverySettings>;
    defaultResumable?: boolean;
    onWarning?: (message: string) => void;
  }): Promise<void>;
}

export interface PrepareSubagentRuntimeOptions {
  ctx: PrepareSubagentRuntimeContext;
  settingsStore: Pick<SubagentSettingsStore, "load">;
  agentManager: PrepareSubagentRuntimeAgentManager;
  agentRegistry?: PrepareSubagentRuntimeAgentRegistry;
}

export async function prepareSubagentRuntime({
  ctx,
  settingsStore,
  agentManager,
  agentRegistry,
}: PrepareSubagentRuntimeOptions): Promise<SubagentSettings> {
  const settings = await loadSubagentSettings(ctx, settingsStore);
  agentManager.configure?.({ maxRunning: settings.runtime.maxConcurrentSubagents });
  if (agentRegistry) {
    await agentRegistry.reload(ctx.cwd, {
      discovery: settings.agentDiscovery,
      defaultResumable: settings.runtime.defaultResumable,
      onWarning: message => ctx.ui?.notify?.(message, "warning"),
    });
  }
  return settings;
}
