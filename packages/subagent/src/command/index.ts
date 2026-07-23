import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../agents.js";
import type { SubagentRuntime } from "../runtime.js";
import { prepareSubagentRuntime, SubagentSettingsStore, type SubagentSettings } from "../settings.js";
import { updateSubagentWidget } from "../widget.js";
import { SubagentOverlayComponent, type SubagentOverlayPage } from "./overlay.js";
import { applySubagentSettingsChange } from "./settings.js";

export function registerSubagentsCommand(
  pi: ExtensionAPI,
  runtime: SubagentRuntime,
  settingsStore: Pick<SubagentSettingsStore, "load" | "save"> = new SubagentSettingsStore(),
  agentRegistry?: AgentRegistry,
  onSettingsUpdated?: (settings: SubagentSettings) => void,
) {
  pi.registerCommand?.("subagents", {
    description: "Manage subagent conversations and runs",
    getArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI || !ctx.ui?.custom) return;

      const requested = args.trim();
      const initialPage: SubagentOverlayPage = requested === "settings" || requested === "agents" || requested === "conversations"
        ? requested
        : runtime.listConversations().length ? "conversations" : "agents";
      let settings = await prepareSubagentRuntime({
        ctx,
        settingsStore,
        runtime,
        ...(agentRegistry ? { agentRegistry } : {}),
      });
      onSettingsUpdated?.(settings);
      updateSubagentWidget(ctx, runtime.listConversations(), settings);
      let saveQueue = Promise.resolve();

      try {
        await ctx.ui.custom<void>((tui, theme, keys, done) => new SubagentOverlayComponent(
          runtime,
          tui,
          theme,
          keys,
          () => done(undefined),
          {
            initialPage,
            agents: agentRegistry ? [...agentRegistry.agents.values()] : [],
            settings,
            notify: (message, level) => notify(ctx, message, level as any),
            onSettingsChange: change => {
              settings = applySubagentSettingsChange(settings, change);
              runtime.configure({
                maxRunning: settings.runtime.maxConcurrentSubagents,
                maxConversations: settings.runtime.maxConversations,
              });
              if (change.kind === "widgetPlacement" || change.kind === "widgetMode" || change.kind === "widgetMaxRowsPerSection") {
                updateSubagentWidget(ctx, runtime.listConversations(), settings);
              }
              onSettingsUpdated?.(settings);
              const next = settings;
              saveQueue = saveQueue.then(() => settingsStore.save(next)).catch(error => {
                notify(ctx, `Could not save subagent settings: ${errorMessage(error)}`, "warning");
              });
              return settings;
            },
            onStart: (agent, prompt) => {
              const start = runtime.startRun(ctx, [{ kind: "spawn", agent, prompt }]).starts[0];
              if (!start?.ok) {
                notify(ctx, start?.error ?? "Could not start run.", "warning");
                return undefined;
              }
              updateSubagentWidget(ctx, runtime.listConversations(), settings);
              notify(ctx, `Started ${agent} (${start.conversationId}, ${start.runId}).`, "info");
              return start.conversationId;
            },
            onResume: (conversationId, prompt) => {
              const start = runtime.startRun(ctx, [{ kind: "resume", conversationId: conversationId as any, prompt }]).starts[0];
              if (!start?.ok) notify(ctx, start?.error ?? `Could not resume conversation ${conversationId}.`, "warning");
              else {
                updateSubagentWidget(ctx, runtime.listConversations(), settings);
                notify(ctx, `Started run ${start.runId} in conversation ${conversationId}.`, "info");
              }
            },
            onRemove: conversationId => {
              const result = runtime.removeConversation(conversationId);
              if (result.removed) notify(ctx, `Removed subagent conversation ${conversationId}.`, "info");
              else notify(ctx, result.errors[0]?.error ?? `Could not remove conversation ${conversationId}.`, "warning");
              updateSubagentWidget(ctx, runtime.listConversations(), settings);
            },
          },
        ), {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", minWidth: 56, maxHeight: "80%" },
        });
      } catch (error) {
        notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
      }
      await saveQueue;
    },
  });
}

function getArgumentCompletions(prefix: string) {
  const values = [
    { value: "conversations", label: "conversations", description: "Open conversations and runs" },
    { value: "agents", label: "agents", description: "Browse agents" },
    { value: "settings", label: "settings", description: "Open settings" },
  ];
  const normalized = prefix.trimStart();
  if (normalized.includes(" ")) return null;
  const filtered = values.filter(value => value.value.startsWith(normalized));
  return filtered.length ? filtered : null;
}

export function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" | "success" = "info",
) {
  if (!ctx.hasUI) return;
  try {
    ctx.ui?.notify?.(message, level as any);
  } catch { }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
