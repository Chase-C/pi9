import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { formatAgentConfigSummary, formatSubagentToolLines, inventoryDetails } from "../view/format.js";
import { SubagentUiSettingsStore } from "../ui/settings.js";
import { loadSubagentUiSettings } from "../ui/widget.js";
import { configureSubagentDisplay } from "../view/view-helpers.js";
import {
  SubagentAgentsComponent,
  SubagentSessionsComponent,
  type SubagentsCommandResult,
} from "./components.js";
import { openSubagentSettings, resumeSessionFromCommand } from "./flows.js";
import { errorMessage, notify } from "./notify.js";

export function registerSubagentsCommand(
  pi: ExtensionAPI,
  agentManager: AgentManager,
  settingsStore: Pick<SubagentUiSettingsStore, "load" | "save"> = new SubagentUiSettingsStore(),
  agentRegistry?: AgentRegistry,
) {
  pi.registerCommand?.("subagents", {
    description: "Manage active and retained subagent sessions",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim() === "settings") {
        await openSubagentSettings(ctx, agentManager, settingsStore);
        return;
      }

      const sessions = agentManager.listSessions();
      if (sessions.length === 0) {
        if (!agentRegistry) {
          notify(ctx, "No active or retained subagent sessions.", "info");
          return;
        }

        const settings = await loadSubagentUiSettings(ctx, settingsStore);
        configureSubagentDisplay(settings.display);
        agentManager.configure?.({ maxRunning: settings.runtime.maxConcurrentSubagents });
        await agentRegistry.reload(ctx.cwd, {
          discovery: settings.agentDiscovery,
          defaultResumable: settings.runtime.defaultResumable,
          onWarning: message => notify(ctx, message, "warning"),
        });
        const agents = Array.from(agentRegistry.agents.values());
        if (!ctx.hasUI || !ctx.ui?.custom) {
          notify(ctx, agents.length
            ? agents.map(formatAgentConfigSummary).join("\n")
            : "No configured subagent agents.", "info");
          return;
        }

        let action: SubagentsCommandResult | undefined;
        try {
          action = await ctx.ui.custom<SubagentsCommandResult | undefined>((tui, theme, keybindings, done) => {
            return new SubagentAgentsComponent(agents, tui, theme, keybindings, result => done(result));
          });
        } catch (error) {
          notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
          return;
        }
        if (action?.action === "settings") await openSubagentSettings(ctx, agentManager, settingsStore);
        return;
      }

      if (!ctx.hasUI || !ctx.ui?.custom) {
        notify(ctx, formatSubagentToolLines(inventoryDetails(sessions), true).join("\n"), "info");
        return;
      }

      let action: SubagentsCommandResult | undefined;
      try {
        action = await ctx.ui.custom<SubagentsCommandResult | undefined>((tui, theme, keybindings, done) => {
          return new SubagentSessionsComponent(
            agentManager,
            tui,
            theme,
            keybindings,
            (message, level) => notify(ctx, message, level as any),
            result => done(result),
          );
        });
      } catch (error) {
        notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
        return;
      }

      if (action?.action === "resume") await resumeSessionFromCommand(pi, agentManager, action, ctx, settingsStore);
    },
  });
}
