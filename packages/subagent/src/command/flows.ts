import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../runtime/agent-manager.js";
import { toResult } from "../domain/agent-result.js";
import { createSubagentResumeMessage } from "../view/resume-message.js";
import type { SubagentSettings, SubagentSettingsStore } from "../config/settings.js";
import { updateSubagentWidget } from "../ui/widget.js";
import { prepareSubagentRuntime } from "../runtime/prepare-subagent-runtime.js";
import {
  SubagentResumeLoader,
  type SubagentResumeCommandResult,
} from "./components.js";
import { applySubagentSettingsChange, SubagentSettingsComponent } from "./components/settings.js";
import { errorMessage, notify } from "./notify.js";

export async function resumeSessionFromCommand(
  pi: ExtensionAPI,
  agentManager: AgentManager,
  action: SubagentResumeCommandResult,
  ctx: ExtensionCommandContext,
  settingsStore: Pick<SubagentSettingsStore, "load">,
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

  const uiSettings = await prepareSubagentRuntime({ ctx, settingsStore, agentManager });
  let outcome: { result?: unknown; error?: unknown };
  try {
    outcome = await ctx.ui.custom<{ result?: unknown; error?: unknown }>((_tui, theme, keybindings, done) => {
      const loader = new SubagentResumeLoader(theme, keybindings, `Resuming subagent ${action.agent}...`);
      let settled = false;
      const finish = (value: { result?: unknown; error?: unknown }) => {
        if (settled) return;
        settled = true;
        done(value);
      };

      agentManager.startRun(ctx, loader.signal, [{ kind: "resume", sessionId: action.sessionId, prompt }], () => {
        updateSubagentWidget(ctx, agentManager.listSessions(), uiSettings);
      }, { background: false }).resultsPromise.then(
        results => finish({ result: results[0] ? toResult(results[0]) : undefined }),
        error => finish({ error }),
      );

      return loader;
    });
  } catch (error) {
    notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
    return;
  }

  const result = normalizeResumeOutcome(action, prompt, outcome);
  updateSubagentWidget(ctx, agentManager.listSessions(), uiSettings);
  pi.sendMessage?.(createSubagentResumeMessage(result, uiSettings.display));
  notify(ctx, result.status === "completed"
    ? `Subagent session ${action.sessionId} resumed.`
    : `Subagent session ${action.sessionId} resume ${result.status}.`,
    result.status === "completed" ? "info" : "warning");
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
  settingsStore: Pick<SubagentSettingsStore, "load" | "save">,
  onSettingsUpdated?: (settings: SubagentSettings) => void,
) {
  let settings = await prepareSubagentRuntime({ ctx, settingsStore, agentManager });
  if (!ctx.hasUI || !ctx.ui?.custom) {
    notify(ctx, `Subagent widget placement: ${settings.widgetPlacement}`, "info");
    return;
  }

  let saveQueue = Promise.resolve();
  try {
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => new SubagentSettingsComponent(
      settings,
      theme,
      keybindings,
      change => {
        const applied = applySubagentSettingsChange(settings, change);
        settings = applied.settings;
        if (change.kind === "widgetPlacement"
          || change.kind === "widgetLayout"
          || change.kind === "widgetShowRetainedSessions"
          || change.kind === "widgetMaxRowsPerSection") {
          updateSubagentWidget(ctx, agentManager.listSessions(), settings);
        } else if (change.kind === "maxConcurrentSubagents") {
          agentManager.configure({ maxRunning: change.value });
        }
        onSettingsUpdated?.(settings);
        const settingsToSave = settings;
        saveQueue = saveQueue.then(() => settingsStore.save(settingsToSave).then(
          () => notify(ctx, applied.confirmation, "info"),
          error => notify(ctx, `Failed to save subagent settings: ${errorMessage(error)}`, "warning"),
        ));
      },
      () => done(undefined),
      () => tui.requestRender(),
    ));
  } catch (error) {
    notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
  }
  await saveQueue;
}
