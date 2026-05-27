import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { formatAgentConfigSummary, formatSubagentToolLines, inventoryDetails } from "../view/format.js";
import { SubagentSettingsStore, type SubagentSettings } from "../config/settings.js";
import { prepareSubagentRuntime } from "../runtime/prepare-subagent-runtime.js";
import {
  SubagentAgentsComponent,
  SubagentSessionsComponent,
  type SubagentsCommandResult,
} from "./components.js";
import { openSubagentSettings, resumeSessionFromCommand } from "./flows.js";
import { errorMessage, notify } from "./notify.js";

type SubagentsCommandView = "sessions" | "agents";

export function registerSubagentsCommand(
  pi: ExtensionAPI,
  agentManager: AgentManager,
  settingsStore: Pick<SubagentSettingsStore, "load" | "save"> = new SubagentSettingsStore(),
  agentRegistry?: AgentRegistry,
  onSettingsUpdated?: (settings: SubagentSettings) => void,
) {
  pi.registerCommand?.("subagents", {
    description: "Manage active and retained subagent sessions",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim() === "settings") {
        await openSubagentSettings(ctx, agentManager, settingsStore, onSettingsUpdated);
        return;
      }

      let view: SubagentsCommandView = agentManager.listSessions().length === 0 ? "agents" : "sessions";

      while (true) {
        let action: SubagentsCommandResult | undefined;

        if (view === "agents") {
          if (!agentRegistry) {
            notify(ctx, "No active or retained subagent sessions.", "info");
            return;
          }

          const settings = await prepareSubagentRuntime({ ctx, settingsStore, agentManager, agentRegistry });
          onSettingsUpdated?.(settings);
          const agents = Array.from(agentRegistry.agents.values());
          if (!ctx.hasUI || !ctx.ui?.custom) {
            notify(ctx, agents.length
              ? agents.map(formatAgentConfigSummary).join("\n")
              : "No configured subagent agents.", "info");
            return;
          }

          try {
            action = await ctx.ui.custom<SubagentsCommandResult | undefined>((tui, theme, keybindings, done) => {
              return new SubagentAgentsComponent(
                agents,
                tui,
                theme,
                keybindings,
                result => done(result),
                () => agentManager.listSessions().length > 0,
              );
            });
          } catch (error) {
            notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
            return;
          }
        } else {
          const settings = await prepareSubagentRuntime({ ctx, settingsStore, agentManager });
          onSettingsUpdated?.(settings);
          const sessions = agentManager.listSessions();

          if (sessions.length === 0) {
            view = "agents";
            continue;
          }

          if (!ctx.hasUI || !ctx.ui?.custom) {
            notify(ctx, formatSubagentToolLines(inventoryDetails(sessions), true, Date.now(), settings.display).join("\n"), "info");
            return;
          }

          try {
            action = await ctx.ui.custom<SubagentsCommandResult | undefined>((tui, theme, keybindings, done) => {
              return new SubagentSessionsComponent(
                agentManager,
                tui,
                theme,
                keybindings,
                settings.display,
                (message, level) => notify(ctx, message, level as any),
                result => done(result),
                Boolean(agentRegistry),
              );
            });
          } catch (error) {
            notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
            return;
          }
        }

        if (action?.action === "agents") {
          view = "agents";
          continue;
        }
        if (action?.action === "sessions") {
          view = "sessions";
          continue;
        }
        if (action?.action === "settings") {
          await openSubagentSettings(ctx, agentManager, settingsStore, onSettingsUpdated);
          return;
        }
        if (action?.action === "resume") await resumeSessionFromCommand(pi, agentManager, action, ctx, settingsStore);
        return;
      }
    },
  });
}
