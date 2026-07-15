import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { AgentRegistry } from "./domain/agent-registry.js";
import { AgentManager } from "./runtime/agent-manager.js";
import { BackgroundNotifier } from "./runtime/background-notifier.js";
import { timingAsync } from "./runtime/timing.js";
import { makeChildSubagentTool } from "./tool/child-tool.js";
import { defineSubagentTool } from "./tool/define-subagent-tool.js";
import { SubagentSettingsStore, DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./config/settings.js";
import { registerSubagentLifecycleEvents } from "./runtime/lifecycle-events.js";
import { prepareSubagentRuntime } from "./runtime/prepare-subagent-runtime.js";
import { registerSubagentMetadataPersistence } from "./runtime/session-metadata.js";
import { registerSubagentSessionGuards } from "./runtime/session-guards.js";
import { registerSubagentsCommand } from "./command/register.js";
import {
  formatBackgroundCompletionMessage,
  type BackgroundCompletionMessageDetails,
} from "./view/background-completion-message.js";
import {
  formatSubagentResumeMessageRender,
  type SubagentResumeMessageDetails,
} from "./view/resume-message.js";


interface SubagentExtensionDependencies {
  agentRegistry?: AgentRegistry;
  agentManager?: AgentManager;
  settingsStore?: Pick<SubagentSettingsStore, "load" | "save">;
}

export default function subagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}) {
  const agentRegistry = dependencies.agentRegistry ?? new AgentRegistry();
  const agentManager = dependencies.agentManager ?? new AgentManager(agentRegistry);
  const settingsStore = dependencies.settingsStore ?? new SubagentSettingsStore();

  let currentSettings: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS;
  const getCurrentSettings = () => currentSettings;
  agentManager.runner?.setChildTool?.(parent =>
    makeChildSubagentTool({ manager: agentManager, registry: agentRegistry, parent, getCurrentSettings })
  );

  new BackgroundNotifier({
    pi: pi as any,
    manager: agentManager,
    getMode: () => currentSettings.runtime.backgroundNotify,
    getDisplay: () => currentSettings.display,
  });

  registerSubagentLifecycleEvents(pi.events, agentManager);
  registerSubagentMetadataPersistence(pi, agentManager, () => currentSettings.display);
  registerSubagentSessionGuards(pi as any, agentManager);

  registerSubagentsCommand(pi, agentManager, settingsStore, agentRegistry, settings => {
    currentSettings = settings;
  });
  try {
    pi.registerMessageRenderer?.<SubagentResumeMessageDetails>("subagent-resume", (message, options, theme) => {
      const content = formatSubagentResumeMessageRender(message.details!, Boolean(options?.expanded), theme, currentSettings.display);
      return new Text(theme?.fg ? theme.fg("customMessageText", content) : content, 0, 0);
    });
  } catch { }
  try {
    pi.registerMessageRenderer?.<BackgroundCompletionMessageDetails>("subagent-background-completion", (message, options, theme) => {
      return new Text(formatBackgroundCompletionMessage(message.details!, Boolean(options?.expanded), theme, currentSettings.display), 0, 0);
    });
  } catch { }

  pi.registerTool(defineSubagentTool({
    agentManager,
    agentRegistry,
    getCurrentSettings,
    prepareInvocation: async (ctx: ExtensionContext) => {
      const settings = await timingAsync(
        "tool.prepareRuntime",
        { hasUI: ctx.hasUI, cwd: ctx.cwd },
        () => prepareSubagentRuntime({ ctx, settingsStore, agentManager, agentRegistry }),
      );
      currentSettings = settings;
      return settings;
    },
  }));
}
