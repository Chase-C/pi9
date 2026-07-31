import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { AgentRegistry } from "./agents.js";
import { type Conversation, type ConversationSnapshot, type ConversationUpdateKind } from "./conversation.js";
import { SubagentRuntime } from "./runtime.js";
import {
  CompletionNotifier,
  formatCompletionNotificationMessage,
  type CompletionNotificationMessageDetails,
} from "./notifications.js";
import { generationElapsedMs } from "./generation-format.js";
import { timingAsync } from "./timing.js";
import { defineSubagentTool, makeChildSubagentTool } from "./tool.js";
import { SubagentSettingsStore, DEFAULT_SUBAGENT_SETTINGS, prepareSubagentRuntime, type SubagentSettings } from "./settings.js";
import { registerSubagentsCommand } from "./command/index.js";
import { registerSubagentWidgetLifecycle, updateSubagentWidget } from "./widget.js";

export type { CanonicalFinishedSubagent, CanonicalLiveSubagent, SubagentIdentity } from "./contract.js";
export type { SubagentAction, SubagentStatus } from "./schema.js";
export type { SubagentBatchSummary, SubagentErrorEnvelope, SubagentResponseEnvelope, SubagentResultsEnvelope } from "./tool-contract.js";

interface SubagentExtensionDependencies {
  agentRegistry?: AgentRegistry;
  runtime?: SubagentRuntime;
  settingsStore?: Pick<SubagentSettingsStore, "load" | "save">;
}

export default function subagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}) {
  const agentRegistry = dependencies.agentRegistry ?? new AgentRegistry();
  const runtime = dependencies.runtime ?? new SubagentRuntime(
    agentRegistry,
    DEFAULT_SUBAGENT_SETTINGS.runtime.maxConcurrentSubagents,
    undefined,
    DEFAULT_SUBAGENT_SETTINGS.runtime.maxConversations,
  );
  const settingsStore = dependencies.settingsStore ?? new SubagentSettingsStore();

  let currentSettings: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS;
  const getCurrentSettings = () => currentSettings;
  registerSubagentWidgetLifecycle(pi, runtime, getCurrentSettings);

  const completionNotifier = new CompletionNotifier({
    pi: pi as any,
    manager: runtime,
    getMode: () => currentSettings.runtime.completionNotify,
  });
  pi.on("context", event => ({ messages: completionNotifier.reconcileMessages(event.messages) }));
  runtime.scheduler.setChildTool(parent =>
    makeChildSubagentTool({ runtime, agentRegistry, parent, getCurrentSettings })
  );
  runtime.scheduler.setChildSessionEvent((parent, generation, event) =>
    completionNotifier.handleToolEvent(`child:${parent.conversationId}:${generation.number}`, event)
  );

  registerSubagentLifecycleEvents(pi.events, runtime);
  registerSubagentMetadataPersistence(pi, runtime);
  registerSubagentSessionGuards(pi as any, runtime);

  registerSubagentsCommand(pi, runtime, settingsStore, agentRegistry, settings => {
    currentSettings = settings;
  });
  try {
    pi.registerMessageRenderer?.<CompletionNotificationMessageDetails>("subagent-completion", (message, options, theme) => {
      return new Text(formatCompletionNotificationMessage(message.details!, Boolean(options?.expanded), theme, currentSettings.display), 0, 0);
    });
  } catch { }

  pi.registerTool(defineSubagentTool({
    runtime,
    agentRegistry,
    prepareInvocation: async (ctx: ExtensionContext) => {
      const settings = await timingAsync(
        "tool.prepareRuntime",
        { hasUI: ctx.hasUI, cwd: ctx.cwd },
        () => prepareSubagentRuntime({ ctx, settingsStore, runtime, agentRegistry }),
      );
      currentSettings = settings;
      updateSubagentWidget(ctx, runtime.listConversations(), settings);
      return settings;
    },
  }));
}

export interface SubagentEventBus { emit(event: string, data: unknown): void }
export interface SubagentLifecycleEventSource {
  onConversationUpdate?(listener: (agent: Conversation, kind: ConversationUpdateKind) => void): () => void;
  projectSubagent(conversationId: string): ReturnType<SubagentRuntime["projectSubagent"]>;
}

/** Emits lifecycle events keyed by stable subagent identity. */
export function registerSubagentLifecycleEvents(events: SubagentEventBus | undefined, source: SubagentLifecycleEventSource): () => void {
  if (!events?.emit || !source.onConversationUpdate) return () => {};
  const seen = new Set<string>();
  return source.onConversationUpdate((agent, kind) => {
    if (kind !== "status") return;
    const generation = agent.snapshot().generations.at(-1);
    if (!generation) return;
    const snapshot = source.projectSubagent(agent.conversationId);
    const timestamp = generation.status.kind === "queued" ? generation.status.queuedAt
      : generation.status.kind === "running" ? generation.status.startedAt
      : generation.status.completedAt;
    const key = JSON.stringify([agent.conversationId, generation.generation, snapshot.status, timestamp]);
    if (seen.has(key)) return;
    seen.add(key);
    const event = snapshot.status === "queued" ? "subagent:queued"
      : snapshot.status === "running" ? "subagent:started"
      : "subagent:finished";
    events.emit(event, snapshot);
  });
}

interface GuardPi { on?(event: "session_before_switch" | "session_before_fork", handler: (event: unknown, ctx: GuardContext) => Promise<{ cancel: true } | undefined>): void }
interface GuardContext { hasUI?: boolean; ui?: { confirm?(title: string, message: string): Promise<boolean> } }
interface GuardManager { listConversations(): ConversationSnapshot[] }
export function registerSubagentSessionGuards(pi: GuardPi, manager: GuardManager): void { const guard = (_: unknown, ctx: GuardContext) => confirmWithActiveSubagents(ctx, manager); pi.on?.("session_before_switch", guard); pi.on?.("session_before_fork", guard); }
export async function confirmWithActiveSubagents(ctx: GuardContext, manager: GuardManager): Promise<{ cancel: true } | undefined> {
  const active = manager.listConversations().filter(item => item.currentGeneration !== undefined || item.isStopping);
  if (!active.length || !ctx.hasUI || !ctx.ui?.confirm) return;
  const lines = active.slice(0, 6).map(item => `- ${item.agent.name}${item.label !== item.agent.name ? ` (${item.label})` : ""}: ${item.currentGeneration?.status.kind ?? "stopping"}`);
  if (active.length > 6) lines.push(`- ... and ${active.length - 6} more`);
  const ok = await ctx.ui.confirm("Active subagents", `${active.length} subagent${active.length === 1 ? " is" : "s are"} still active:\n${lines.join("\n")}\n\nChanging sessions will tear down this extension runtime. Continue anyway?`);
  return ok ? undefined : { cancel: true };
}

interface MetadataPi { appendEntry?(customType: string, data?: unknown): void }
interface MetadataSource { onConversationUpdate?(listener: (agent: Conversation, kind: ConversationUpdateKind) => void): () => void }
export function registerSubagentMetadataPersistence(pi: MetadataPi, source: MetadataSource): () => void {
  if (!pi.appendEntry || !source.onConversationUpdate) return () => {};
  const persisted = new Set<string>();
  return source.onConversationUpdate((agent, kind) => {
    if (kind !== "status") return;
    const snapshot = agent.snapshot();
    const generation = snapshot.generations.at(-1);
    const key = generation ? JSON.stringify([snapshot.conversationId, generation.generation]) : undefined;
    if (!generation || generation.status.kind !== "done" || !key || persisted.has(key)) return;
    persisted.add(key);
    pi.appendEntry!("subagent-generation-index", projectSubagentGenerationIndex(snapshot));
  });
}
export function projectSubagentGenerationIndex(snapshot: ReturnType<Conversation["snapshot"]>) {
  const generation = snapshot.generations.at(-1);
  if (!generation || generation.status.kind !== "done") throw new Error("Cannot persist a non-terminal generation.");
  return {
    version: 4,
    subagentId: snapshot.conversationId,
    generation: generation.generation,
    agent: snapshot.agent.name,
    ...(snapshot.label ? { label: snapshot.label } : {}),
    kind: generation.kind,
    status: generation.status.outcome,
    completedAt: generation.status.completedAt,
    ...(generation.status.startedAt !== undefined ? {
      startedAt: generation.status.startedAt,
      elapsedMs: generationElapsedMs(generation),
    } : {}),
  };
}
