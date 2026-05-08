import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";

import type { AgentManager } from "../runtime/agent-manager.js";
import { createSubagentResumeMessage } from "../view/resume-message.js";
import type { SubagentUiSettingsStore } from "../ui/settings.js";
import { loadSubagentUiSettings, updateSubagentWidget } from "../ui/widget.js";
import {
  SubagentResumeLoader,
  SubagentSettingsComponent,
  type SubagentResumeCommandResult,
} from "./components.js";
import type { SubagentKeybindings, SubagentSessionsTheme } from "./input.js";
import { errorMessage, notify } from "./notify.js";

export async function resumeSessionFromCommand(
  pi: ExtensionAPI,
  agentManager: AgentManager,
  action: SubagentResumeCommandResult,
  ctx: ExtensionCommandContext,
  settingsStore: Pick<SubagentUiSettingsStore, "load">,
) {
  if (!ctx.hasUI || !ctx.ui?.custom || typeof (ctx.ui as any).editor !== "function") {
    notify(ctx, "Resume UI is unavailable for subagent sessions.", "warning");
    return;
  }

  let prompt: unknown;
  try {
    prompt = await (ctx.ui as any).editor(`Resume subagent ${action.agent}`, "");
  } catch (error) {
    notify(ctx, `Subagent resume editor UI failed: ${errorMessage(error)}`, "warning");
    return;
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    notify(ctx, "Subagent resume cancelled: no follow-up prompt provided.", "info");
    return;
  }

  const uiSettings = await loadSubagentUiSettings(ctx, settingsStore);
  let outcome: { result?: unknown; error?: unknown };
  try {
    outcome = await ctx.ui.custom<{ result?: unknown; error?: unknown }>((tui, theme, keybindings, done) => {
      const loader = createResumeLoader(tui, theme, keybindings, `Resuming subagent ${action.agent}...`);
      let settled = false;
      const finish = (value: { result?: unknown; error?: unknown }) => {
        if (settled) return;
        settled = true;
        done(value);
      };

      agentManager.resume(ctx, loader.signal, action.sessionId, prompt, update => {
        updateSubagentWidget(ctx, update.sessions, uiSettings);
      }).then(
        result => finish({ result }),
        error => finish({ error }),
      );

      return loader;
    });
  } catch (error) {
    notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
    return;
  }

  const result = normalizeResumeOutcome(action, prompt, outcome);
  updateSubagentWidget(ctx, agentManager.sessions, uiSettings);
  pi.sendMessage?.(createSubagentResumeMessage(result));
  notify(ctx, result.status === "completed"
    ? `Subagent session ${action.sessionId} resumed.`
    : `Subagent session ${action.sessionId} resume ${result.status}.`,
    result.status === "completed" ? "info" : "warning");
}

function createResumeLoader(_tui: TUI, theme: SubagentSessionsTheme, keybindings: SubagentKeybindings, message: string) {
  return new SubagentResumeLoader(theme, keybindings, message);
}

function normalizeResumeOutcome(action: SubagentResumeCommandResult, prompt: string, outcome: { result?: unknown; error?: unknown }) {
  if (outcome?.result && typeof outcome.result === "object") return outcome.result as {
    agent: string;
    prompt: string;
    status: string;
    output?: string;
    error?: string;
    sessionId?: string;
    resumable?: boolean;
  };

  const error = outcome?.error ? errorMessage(outcome.error) : "Subagent resume failed.";
  return {
    agent: action.agent,
    prompt,
    status: "error",
    error,
    sessionId: action.sessionId,
    resumable: true,
  };
}

export async function openSubagentSettings(
  ctx: ExtensionCommandContext,
  agentManager: AgentManager,
  settingsStore: Pick<SubagentUiSettingsStore, "load" | "save">,
) {
  let settings = await loadSubagentUiSettings(ctx, settingsStore);
  if (!ctx.hasUI || !ctx.ui?.custom) {
    notify(ctx, `Subagent widget placement: ${settings.widgetPlacement}`, "info");
    return;
  }

  let saveQueue = Promise.resolve();
  try {
    await ctx.ui.custom<void>((_tui, theme, keybindings, done) => new SubagentSettingsComponent(
      settings,
      theme,
      keybindings,
      placement => {
        settings = { widgetPlacement: placement };
        updateSubagentWidget(ctx, agentManager.sessions, settings);
        const settingsToSave = settings;
        saveQueue = saveQueue.then(() => settingsStore.save(settingsToSave).then(
          () => notify(ctx, `Subagent widget placement set to ${placement}.`, "info"),
          error => notify(ctx, `Failed to save subagent settings: ${errorMessage(error)}`, "warning"),
        ));
      },
      () => done(undefined),
    ));
  } catch (error) {
    notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
  }
  await saveQueue;
}
