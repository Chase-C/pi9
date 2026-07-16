import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AgentRegistry } from "../domain/agent-registry.js";
import { toResult } from "../domain/agent-result.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { createSubagentResumeMessage } from "../view/resume-message.js";
import { SubagentSettingsStore, type SubagentSettings } from "../config/settings.js";
import { prepareSubagentRuntime } from "../runtime/prepare-subagent-runtime.js";
import { updateSubagentWidget } from "../ui/widget.js";
import { SubagentOverlayComponent, type SubagentOverlayPage } from "./components/overlay.js";
import { applySubagentSettingsChange } from "./components/settings.js";
import { errorMessage, notify } from "./notify.js";

export function registerSubagentsCommand(
  pi: ExtensionAPI,
  agentManager: AgentManager,
  settingsStore: Pick<SubagentSettingsStore, "load" | "save"> = new SubagentSettingsStore(),
  agentRegistry?: AgentRegistry,
  onSettingsUpdated?: (settings: SubagentSettings) => void,
) {
  pi.registerCommand?.("subagents", {
    description: "Manage active and retained subagent sessions",
    getArgumentCompletions: (prefix: string) => getSubagentsArgumentCompletions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI || !ctx.ui?.custom) return;

      const command = args.trim();
      const initialPage: SubagentOverlayPage = command === "settings" || command === "agents" || command === "sessions"
        ? command
        : agentManager.listSessions().length === 0 ? "agents" : "sessions";

      let settings = await prepareSubagentRuntime({
        ctx,
        settingsStore,
        agentManager,
        ...(agentRegistry ? { agentRegistry } : {}),
      });
      onSettingsUpdated?.(settings);
      const agents = agentRegistry ? Array.from(agentRegistry.agents.values()) : [];
      let saveQueue = Promise.resolve();

      try {
        await ctx.ui.custom<void>((tui, theme, keybindings, done) => new SubagentOverlayComponent(
          agentManager,
          tui,
          theme,
          keybindings,
          () => done(undefined),
          {
            initialPage,
            agents,
            settings,
            notify: (message, level) => notify(ctx, message, level as any),
            onSettingsChange: change => {
              const applied = applySubagentSettingsChange(settings, change);
              settings = applied.settings;
              if (change.kind === "maxConcurrentSubagents") agentManager.configure({ maxRunning: change.value });
              if (change.kind === "widgetPlacement"
                || change.kind === "widgetLayout"
                || change.kind === "widgetShowRetainedSessions"
                || change.kind === "widgetMaxRowsPerSection") {
                updateSubagentWidget(ctx, agentManager.listSessions(), settings);
              }
              onSettingsUpdated?.(settings);
              const next = settings;
              saveQueue = saveQueue.then(() => settingsStore.save(next).then(
                () => notify(ctx, applied.confirmation, "info"),
                error => notify(ctx, `Failed to save subagent settings: ${errorMessage(error)}`, "warning"),
              ));
              return settings;
            },
            onResume: (sessionId, prompt) => {
              const session = agentManager.listAttachedSessions().find(candidate => candidate.id === sessionId);
              if (!session) return;
              const handle = agentManager.startRun(
                ctx,
                undefined,
                [{ kind: "resume", sessionId, prompt }],
                () => updateSubagentWidget(ctx, agentManager.listSessions(), settings),
                { background: false },
              );
              void handle.resultsPromise.then(
                results => {
                  const snapshot = results[0];
                  if (!snapshot) return;
                  const result = toResult(snapshot);
                  updateSubagentWidget(ctx, agentManager.listSessions(), settings);
                  pi.sendMessage?.(createSubagentResumeMessage(result, settings.display));
                  notify(ctx, result.status === "completed"
                    ? `Subagent session ${sessionId} resumed.`
                    : `Subagent session ${sessionId} resume ${result.status}.`,
                    result.status === "completed" ? "info" : "warning");
                },
                error => notify(ctx, `Failed to resume subagent session ${sessionId}: ${errorMessage(error)}`, "warning"),
              );
            },
          },
        ), {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            minWidth: 56,
            maxHeight: "85%",
          },
        });
      } catch (error) {
        notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
      }
      await saveQueue;
    },
  });
}

function getSubagentsArgumentCompletions(prefix: string) {
  const commands = [
    { value: "settings", label: "settings", description: "Open subagent settings" },
    { value: "sessions", label: "sessions", description: "Open active and retained subagent sessions" },
    { value: "agents", label: "agents", description: "Browse discovered subagent definitions" },
  ];
  const normalized = prefix.trimStart();
  if (normalized.includes(" ")) return null;
  const filtered = commands.filter(item => item.value.startsWith(normalized));
  return filtered.length > 0 ? filtered : null;
}
