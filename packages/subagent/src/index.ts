import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { AgentRegistry } from "./domain/agent-registry.js";
import { AgentManager } from "./runtime/agent-manager.js";
import { CompletionNotifier } from "./runtime/completion-notifier.js";
import { timingAsync } from "./runtime/timing.js";
import { makeChildSubagentTool } from "./tool/child-tool.js";
import { defineSubagentTool } from "./tool/define-subagent-tool.js";
import { SubagentSettingsStore, DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./config/settings.js";
import { registerSubagentLifecycleEvents } from "./runtime/lifecycle-events.js";
import { prepareSubagentRuntime } from "./runtime/prepare-subagent-runtime.js";
import { registerSubagentMetadataPersistence } from "./runtime/session-metadata.js";
import { registerSubagentSessionGuards } from "./runtime/session-guards.js";
import { registerSubagentsCommand } from "./command/register.js";
import { registerSubagentWidgetLifecycle } from "./ui/widget.js";
import {
  formatCompletionNotificationMessage,
  type CompletionNotificationMessageDetails,
} from "./view/completion-message.js";

interface SubagentExtensionDependencies {
  agentRegistry?: AgentRegistry;
  agentManager?: AgentManager;
  settingsStore?: Pick<SubagentSettingsStore, "load" | "save">;
}

export default function subagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}) {
  const agentRegistry = dependencies.agentRegistry ?? new AgentRegistry();
  const agentManager = dependencies.agentManager ?? new AgentManager(
    agentRegistry,
    DEFAULT_SUBAGENT_SETTINGS.runtime.maxConcurrentSubagents,
    undefined,
    DEFAULT_SUBAGENT_SETTINGS.runtime.maxConversations,
  );
  const settingsStore = dependencies.settingsStore ?? new SubagentSettingsStore();

  let currentSettings: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS;
  const getCurrentSettings = () => currentSettings;
  registerSubagentWidgetLifecycle(pi, agentManager, getCurrentSettings);
  agentManager.runner?.setChildTool?.(parent =>
    makeChildSubagentTool({ manager: agentManager, registry: agentRegistry, parent, getCurrentSettings })
  );

  const completionNotifier = new CompletionNotifier({
    pi: pi as any,
    manager: agentManager,
    getMode: () => currentSettings.runtime.completionNotify,
    getDisplay: () => currentSettings.display,
  });

  registerSubagentLifecycleEvents(pi.events, agentManager);
  registerSubagentMetadataPersistence(pi, agentManager);
  registerSubagentSessionGuards(pi as any, agentManager);

  registerSubagentsCommand(pi, agentManager, settingsStore, agentRegistry, settings => {
    currentSettings = settings;
  });
  try {
    pi.registerMessageRenderer?.<CompletionNotificationMessageDetails>("subagent-completion", (message, options, theme) => {
      return new Text(formatCompletionNotificationMessage(message.details!, Boolean(options?.expanded), theme, currentSettings.display), 0, 0);
    });
  } catch { }

  pi.registerTool(defineSubagentTool({
    agentManager,
    agentRegistry,
    getCurrentSettings,
    releaseJoinClaims: runIds => completionNotifier.releaseJoinClaims(runIds),
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
