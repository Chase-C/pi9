import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { AgentRegistry } from "./domain/agent-registry.js";
import { AgentManager } from "./runtime/agent-manager.js";
import { BackgroundNotifier } from "./runtime/background-notifier.js";
import { timingAsync } from "./runtime/timing.js";
import { makeChildSubagentFactory } from "./tool/child-factory.js";
import { defineSubagentTool } from "./tool/define-subagent-tool.js";
import { SubagentSettingsStore, DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./config/settings.js";
import { registerSubagentLifecycleEvents } from "./runtime/lifecycle-events.js";
import { prepareSubagentRuntime } from "./runtime/prepare-subagent-runtime.js";
import { registerSubagentMetadataPersistence } from "./runtime/session-metadata.js";
import { registerSubagentSessionGuards } from "./runtime/session-guards.js";
import { registerSubagentsCommand } from "./command/register.js";
import { formatBackgroundCompletionMessage } from "./view/background-completion-message.js";
import { formatSubagentResumeMessageContent, formatSubagentResumeMessageRender } from "./view/resume-message.js";


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
  agentManager.runner?.setChildFactory?.(parent =>
    makeChildSubagentFactory({ manager: agentManager, registry: agentRegistry, parent, getCurrentSettings })
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
  try {
    pi.registerShortcut?.("ctrl+shift+.", {
      description: "Open the subagents panel",
      handler: async () => pi.sendUserMessage?.("/subagents", { deliverAs: "followUp" } as any),
    });
  } catch { }

  registerSubagentsCommand(pi, agentManager, settingsStore, agentRegistry, settings => {
    currentSettings = settings;
  });
  try {
    pi.registerMessageRenderer?.("subagent-resume", (message, options, theme) => {
      const details = message.details as any;
      const content = details && typeof details === "object"
        ? formatSubagentResumeMessageRender(details, Boolean(options?.expanded), theme, currentSettings.display)
        : typeof message.content === "string"
          ? message.content
          : formatSubagentResumeMessageContent(details, currentSettings.display);
      return new Text(theme?.fg ? theme.fg("customMessageText", content) : content, 0, 0);
    });
  } catch { }
  try {
    pi.registerMessageRenderer?.("subagent-background-completion", (message, options, theme) => {
      return new Text(formatBackgroundCompletionMessage(message, Boolean(options?.expanded), theme, currentSettings.display), 0, 0);
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
