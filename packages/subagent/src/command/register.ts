import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { SubagentSettingsStore, type SubagentSettings } from "../config/settings.js";
import { prepareSubagentRuntime } from "../runtime/prepare-subagent-runtime.js";
import { updateSubagentWidget } from "../ui/widget.js";
import { SubagentOverlayComponent, type SubagentOverlayPage } from "./components/overlay.js";
import { applySubagentSettingsChange } from "./components/settings.js";
import { errorMessage, notify } from "./notify.js";

export function registerSubagentsCommand(pi: ExtensionAPI, agentManager: AgentManager, settingsStore: Pick<SubagentSettingsStore, "load" | "save"> = new SubagentSettingsStore(), agentRegistry?: AgentRegistry, onSettingsUpdated?: (settings: SubagentSettings) => void) {
 pi.registerCommand?.("subagents", { description: "Manage subagent conversations and runs", getArgumentCompletions,
  handler: async (args: string, ctx: ExtensionCommandContext) => {
   if (!ctx.hasUI || !ctx.ui?.custom) return;
   const requested = args.trim(); const initialPage: SubagentOverlayPage = requested === "settings" || requested === "agents" || requested === "conversations" ? requested : agentManager.listConversations().length ? "conversations" : "agents";
   let settings = await prepareSubagentRuntime({ ctx, settingsStore, agentManager, ...(agentRegistry ? { agentRegistry } : {}) }); onSettingsUpdated?.(settings);
   try { await ctx.ui.custom<void>((tui, theme, keys, done) => new SubagentOverlayComponent(agentManager, tui, theme, keys, () => done(undefined), {
    initialPage, agents: agentRegistry ? [...agentRegistry.agents.values()] : [], settings, notify: (m,l) => notify(ctx,m,l as any),
    onSettingsChange: change => {
     settings = applySubagentSettingsChange(settings, change as any);
     agentManager.configure({ maxRunning: settings.runtime.maxConcurrentSubagents, maxConversations: settings.runtime.maxConversations });
     onSettingsUpdated?.(settings);
     void settingsStore.save(settings).catch(error => notify(ctx, `Could not save subagent settings: ${errorMessage(error)}`, "warning"));
     updateSubagentWidget(ctx, agentManager.listConversations(), settings); return settings;
    },
    onStart: (agent,prompt) => { const start = agentManager.startRun(ctx,[{kind:"spawn",agent,prompt}]).starts[0]; if (!start?.ok) { notify(ctx,start?.error ?? "Could not start run.","warning"); return; } updateSubagentWidget(ctx,agentManager.listConversations(),settings); return start.conversationId; },
    onResume: (conversationId,prompt) => { const start = agentManager.startRun(ctx,[{kind:"resume",conversationId:conversationId as any,prompt}]).starts[0]; if (!start?.ok) notify(ctx,start?.error ?? `Could not resume conversation ${conversationId}.`,"warning"); else notify(ctx,`Started run ${start.runId} in conversation ${conversationId}.`,"info"); },
    onRemove: conversationId => { const result = agentManager.removeConversation(conversationId); if (result.removed) notify(ctx, `Removed subagent conversation ${conversationId}.`, "info"); else notify(ctx, result.errors[0]?.error ?? `Could not remove conversation ${conversationId}.`, "warning"); updateSubagentWidget(ctx, agentManager.listConversations(), settings); },
   }), { overlay:true, overlayOptions:{anchor:"center",width:"90%",minWidth:56,maxHeight:"80%"} }); } catch(error) { notify(ctx,`Subagents UI failed: ${errorMessage(error)}`,"warning"); }
  }
 });
}
function getArgumentCompletions(prefix:string) { const values=[{value:"conversations",label:"conversations",description:"Open conversations and runs"},{value:"agents",label:"agents",description:"Browse agents"},{value:"settings",label:"settings",description:"Open settings"}]; const p=prefix.trimStart(); if(p.includes(" ")) return null; return values.filter(v=>v.value.startsWith(p)) || null; }
