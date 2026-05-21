import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { AgentRegistry } from "./domain/agent-registry.js";
import { AgentManager } from "./runtime/agent-manager.js";
import { BackgroundNotifier } from "./runtime/background-notifier.js";
import { timingAsync } from "./runtime/timing.js";
import { makeChildSubagentFactory } from "./tool/child-factory.js";
import { defineSubagentTool } from "./tool/define-subagent-tool.js";
import { SubagentUiSettingsStore, DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./ui/settings.js";
import { loadSubagentUiSettings } from "./ui/widget.js";
import { registerSubagentsCommand } from "./command/register.js";
import { formatSubagentResumeMessageContent } from "./view/resume-message.js";


interface SubagentExtensionDependencies {
  agentRegistry?: AgentRegistry;
  agentManager?: AgentManager;
  settingsStore?: Pick<SubagentUiSettingsStore, "load" | "save">;
}

export default function subagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}) {
  const agentRegistry = dependencies.agentRegistry ?? new AgentRegistry();
  const agentManager = dependencies.agentManager ?? new AgentManager(agentRegistry);
  const settingsStore = dependencies.settingsStore ?? new SubagentUiSettingsStore();

  let currentSettings: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS;
  const getCurrentSettings = () => currentSettings;
  agentManager.runner?.setChildFactory?.(parent =>
    makeChildSubagentFactory({ manager: agentManager, registry: agentRegistry, parent, getCurrentSettings }));
  new BackgroundNotifier({
    pi: pi as any,
    manager: agentManager,
    getMode: () => currentSettings.runtime.backgroundNotify,
  });

  registerSubagentsCommand(pi, agentManager, settingsStore, agentRegistry, settings => {
    currentSettings = settings;
  });
  try {
    pi.registerMessageRenderer?.("subagent-resume", (message, _options, theme) => {
      const content = typeof message.content === "string"
        ? message.content
        : formatSubagentResumeMessageContent(message.details as any);
      return new Text(theme?.fg ? theme.fg("customMessageText", content) : content, 0, 0);
    });
  } catch { }

  pi.registerTool(defineSubagentTool({
    agentManager,
    agentRegistry,
    getCurrentSettings,
    prepareInvocation: async (ctx: ExtensionContext) => {
      const settings = await timingAsync("tool.loadSettings", { hasUI: ctx.hasUI }, () => loadSubagentUiSettings(ctx, settingsStore));
      currentSettings = settings;
      agentManager.configure?.({ maxRunning: settings.runtime.maxConcurrentSubagents });
      await timingAsync("tool.agentRegistry.reload", { cwd: ctx.cwd }, () => agentRegistry.reload(ctx.cwd, {
        discovery: settings.agentDiscovery,
        defaultResumable: settings.runtime.defaultResumable,
        onWarning: message => ctx.ui?.notify?.(message, "warning"),
      }));
      return settings;
    },
  }));
}
