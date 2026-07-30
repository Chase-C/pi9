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
import { runElapsedMs } from "./run-format.js";
import { timingAsync } from "./timing.js";
import { defineSubagentTool, makeChildSubagentTool } from "./tool.js";
import { SubagentSettingsStore, DEFAULT_SUBAGENT_SETTINGS, prepareSubagentRuntime, type SubagentSettings } from "./settings.js";
import { registerSubagentsCommand } from "./command/index.js";
import { registerSubagentWidgetLifecycle, updateSubagentWidget } from "./widget.js";

export type { CanonicalLiveSubagent } from "./contract.js";
export type { SubagentAction, SubagentStatus } from "./schema.js";

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
    makeChildSubagentTool({ manager: runtime, registry: agentRegistry, parent, getCurrentSettings })
  );
  runtime.scheduler.setChildSessionEvent((_parent, run, event) =>
    completionNotifier.handleToolEvent(`child:${run.runId}`, event)
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
    const internal = agent.snapshot().runs.at(-1);
    if (!internal) return;
    const snapshot = source.projectSubagent(agent.conversationId);
    const timestamp = internal.status.kind === "queued" ? internal.status.queuedAt
      : internal.status.kind === "running" ? internal.status.startedAt
      : internal.status.completedAt;
    const key = `${internal.runId}:${snapshot.status}:${timestamp}`;
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
  const active = manager.listConversations().filter(item => item.currentRun !== undefined || item.isStopping);
  if (!active.length || !ctx.hasUI || !ctx.ui?.confirm) return;
  const lines = active.slice(0, 6).map(item => `- ${item.config.name}${item.label !== item.config.name ? ` (${item.label})` : ""}: ${item.currentRun?.status.kind ?? "stopping"}`);
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
    if (kind !== "status") return; const snapshot = agent.snapshot(); const run = snapshot.runs.at(-1);
    if (!run || run.status.kind !== "done" || persisted.has(run.runId)) return; persisted.add(run.runId);
    pi.appendEntry!("subagent-run-index", projectSubagentRunIndex(snapshot));
  });
}
export function projectSubagentRunIndex(snapshot: ReturnType<Conversation["snapshot"]>) {
  const run = snapshot.runs.at(-1); if (!run || run.status.kind !== "done") throw new Error("Cannot persist a non-terminal run.");
  return { version: 3, subagentId: snapshot.conversationId, agent: snapshot.config.name, ...(snapshot.label ? { label: snapshot.label } : {}), kind: run.kind, status: run.status.outcome, completedAt: run.status.completedAt, ...(run.status.startedAt !== undefined ? { startedAt: run.status.startedAt, elapsedMs: runElapsedMs(run) } : {}) };
}
