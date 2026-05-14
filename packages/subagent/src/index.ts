import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { AgentRegistry } from "./domain/agent-registry.js";
import type { SubagentBatchUpdate } from "./domain/agent-view.js";
import { AgentManager } from "./runtime/agent-manager.js";
import { timingAsync, timingMark, timingStart, timingSync } from "./runtime/timing.js";
import { isSessionStatus, parseTask, SESSION_STATUSES, SubagentParams, type SessionStatus, type TaskRequest } from "./schema.js";
import { SubagentUiSettingsStore, DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./ui/settings.js";
import { BackgroundNotifier } from "./runtime/background-notifier.js";
import { loadSubagentUiSettings, updateSubagentWidget } from "./ui/widget.js";
import { registerSubagentsCommand } from "./command/register.js";
import {
  agentsDetails,
  backgroundResultsDetails,
  backgroundStartedDetails,
  createSubagentTextComponent,
  formatSubagentToolLines,
  inventoryDetails,
  runDetails,
} from "./view/format.js";
import { formatSubagentResumeMessageContent } from "./view/resume-message.js";
import { configureSubagentDisplay, getSubagentDisplaySettings } from "./view/view-helpers.js";
import { listAgentDefinitions, serializeGroup } from "./view/serialize.js";


interface SubagentExtensionDependencies {
  agentRegistry?: AgentRegistry;
  agentManager?: AgentManager;
  settingsStore?: Pick<SubagentUiSettingsStore, "load" | "save">;
}

function validateTaskCount(tasks: SubagentParams["tasks"] | undefined, maxTasks = DEFAULT_SUBAGENT_SETTINGS.runtime.maxTasksPerRun) {
  if (!Array.isArray(tasks)) return "Provide a tasks array for action=run.";
  if (tasks.length === 0) return "Provide at least one task.";
  if (tasks.length > maxTasks) return `Too many tasks (${tasks.length}). Max is ${maxTasks}.`;
  return undefined;
}

function isRemoveScope(scope: unknown): scope is "background" | "retained" | "non-running" {
  return scope === "background" || scope === "retained" || scope === "non-running";
}

function validateRemoveSessionIds(sessionIds: unknown): sessionIds is string[] {
  return Array.isArray(sessionIds) && sessionIds.every(id => typeof id === "string");
}

function validateNonEmptySessionIds(sessionIds: unknown): sessionIds is string[] {
  return Array.isArray(sessionIds) && sessionIds.every(id => typeof id === "string" && id.trim() !== "");
}

function toolResult(details: object, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
    isError,
  };
}

function errorResult(message: string, details: Record<string, unknown> = { }) {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
    isError: true,
  };
}

function partialToolResult(update: SubagentBatchUpdate) {
  const details = runDetails(serializeGroup(update.sessions), { active: update.active });
  return {
    content: [{ type: "text" as const, text: formatSubagentToolLines(details, true).join("\n") }],
    details,
  };
}

export default function subagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}) {
  const agentRegistry = dependencies.agentRegistry ?? new AgentRegistry();
  const agentManager = dependencies.agentManager ?? new AgentManager(agentRegistry);
  const settingsStore = dependencies.settingsStore ?? new SubagentUiSettingsStore();

  let currentSettings: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS;
  const notifier = new BackgroundNotifier({
    pi: pi as any,
    manager: agentManager,
    getMode: () => currentSettings.runtime.backgroundNotify,
  });
  try { pi.on("session_shutdown", () => notifier.dispose()); } catch { }

  registerSubagentsCommand(pi, agentManager, settingsStore, agentRegistry);
  try {
    pi.registerMessageRenderer?.("subagent-resume", (message, _options, theme) => {
      const content = typeof message.content === "string"
        ? message.content
        : formatSubagentResumeMessageContent(message.details as any);
      return new Text(theme?.fg ? theme.fg("customMessageText", content) : content, 0, 0);
    });
  } catch { }

  pi.registerTool(defineTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate focused work to a specialized subagent in an isolated context window. The subagent sees only its system prompt plus the prompt you provide — make prompts self-contained: name the objective, relevant files/dirs, constraints, and the expected output format.

When the user names a specific agent, just call { action: "run" } with that name — unknown-agent errors already list what's available. Otherwise call { action: "agents" } to see which specialized agents are configured and pick one whose tools/skills/prompt actually fit. If nothing fits, do the work yourself rather than spawning a generic delegate.

Prefer doing the work yourself when:
- You can finish it in a handful of tool calls.
- You'd need to read the subagent's output and act on it yourself anyway — delegation just adds steps without offloading context.
- The subagent would mostly re-do work you already have context for.

Subagents pay off for searches or reads that would otherwise crowd this conversation, long-horizon focused tasks with a clean handoff back, or work that benefits from an independent context (e.g. a reviewer).

Call shapes:

  { action: "agents" }
  { action: "list", status?: [SessionStatus, ...] }
  { action: "run", background?: boolean, tasks: [SpawnTask | ResumeTask, ...] }
  { action: "results", sessionIds: [string, ...], remove?: boolean }
  { action: "remove", sessionIds: [string, ...] }
  { action: "remove", scope: Scope }

  SpawnTask     = { agent, prompt, label?, resumable?, model?, thinking?, cwd?, skills? }
  ResumeTask    = { sessionId, prompt, label?, resumable? }
  SessionStatus = "queued" | "running"                                            // active
                | "completed" | "error" | "aborted" | "interrupted" | "skipped"   // terminal
  Scope         = "background"    // background-dispatched sessions
                | "retained"      // resumable foreground sessions kept after completion
                | "non-running"   // everything except currently-running sessions

\`resumable: true\` keeps the session alive after completion so its sessionId can be passed in a ResumeTask later. The flag is one-way at completion — \`resumable: false\` discards the session immediately, on either spawn or resume.

With background: true the run dispatches non-blocking; you'll be notified automatically when children complete (no need to poll). Fetch output with { action: "results" } once notified. One writer at a time — parallel tasks should be independent and should not edit overlapping files. Results preserve input order.
`,
    promptSnippet: "Delegate focused work to specialized subagents in isolated context windows",
    promptGuidelines: [
      "Use subagent for work that benefits from independent context, such as codebase reconnaissance, long-running investigation, review, or parallel research; prefer doing the work yourself for small direct tasks.",
      "Before using subagent without a named agent from the user, call subagent with action: \"agents\" and choose an agent whose prompt, tools, or skills fit the task.",
      "When calling subagent, make each child prompt self-contained with the objective, relevant files or directories, constraints, and expected output format.",
    ],
    parameters: SubagentParams,
    renderCall(args: any, theme: any) {
      const action = typeof args?.action === "string" ? args.action : "pending";
      const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
      const labels = tasks
        .map((task: any) => (typeof task?.label === "string" ? task.label : undefined))
        .filter((label: string | undefined): label is string => Boolean(label));
      let suffix = "";
      if (labels.length > 0) {
        const limit = getSubagentDisplaySettings().toolCallLabelMaxLength;
        const joined = labels.join(", ");
        const truncated = joined.length > limit ? `${joined.slice(0, Math.max(0, limit - 3))}...` : joined;
        suffix = ` · ${truncated}`;
      } else if (tasks.length) {
        suffix = ` · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
      }
      const line = `subagent ${action}${suffix}`;
      return new Text(theme?.fg ? theme.fg("toolTitle", line) : line, 0, 0);
    },
    renderResult(result: any, options: any, theme: any) {
      try {
        const component = createSubagentTextComponent(result?.details, Boolean(options?.expanded), theme);
        if (component) return component;
      } catch { }
      const text = result?.content?.find((part: any) => part?.type === "text")?.text ?? "";
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      timingMark("tool.execute.start", { action: params.action, taskCount: Array.isArray(params.tasks) ? params.tasks.length : undefined, cwd: ctx.cwd });
      const settings = await timingAsync("tool.loadSettings", { hasUI: ctx.hasUI }, () => loadSubagentUiSettings(ctx, settingsStore));
      currentSettings = settings;
      configureSubagentDisplay(settings.display);
      agentManager.configure?.({ maxRunning: settings.runtime.maxConcurrentSubagents });
      await timingAsync("tool.agentRegistry.reload", { cwd: ctx.cwd }, () => agentRegistry.reload(ctx.cwd, {
        discovery: settings.agentDiscovery,
        defaultResumable: settings.runtime.defaultResumable,
        onWarning: message => ctx.ui?.notify?.(message, "warning"),
      }));

      if (!params.action) {
        return errorResult(`Provide an action: "agents", "list", "run", "results", or "remove".\n\nAvailable agents:\n${agentRegistry.summarizeAgent()}`);
      }

      switch (params.action) {
        case "agents":
          return toolResult(agentsDetails(listAgentDefinitions(agentRegistry)));

        case "list": {
          if ((params as { type?: unknown }).type !== undefined) {
            return errorResult("The 'type' parameter has been removed. Use action: 'agents' to list definitions, or action: 'list' (optionally with status: [...]) for sessions. Skills listing is no longer exposed through the subagent tool.");
          }
          const statusFilter = params.status;
          if (statusFilter !== undefined && !Array.isArray(statusFilter)) {
            return errorResult("list status must be an array of status strings.");
          }
          const invalidStatus = statusFilter?.find(value => !isSessionStatus(value));
          if (invalidStatus !== undefined) {
            return errorResult(`Unknown status '${String(invalidStatus)}'. Valid: ${SESSION_STATUSES.join(", ")}.`);
          }
          const filter = statusFilter !== undefined ? { status: statusFilter as SessionStatus[] } : undefined;
          return toolResult(inventoryDetails(agentManager.listSessions(filter), filter));
        }

        case "run": {
          const countError = validateTaskCount(params.tasks, settings.runtime.maxTasksPerRun);
          if (countError) {
            return errorResult(`${countError}\n\nAvailable agents:\n${agentRegistry.summarizeAgent()}`);
          }

          const parsed: TaskRequest[] = [];
          const errors: string[] = [];
          timingSync("tool.parseTasks", { taskCount: params.tasks?.length ?? 0 }, () => {
            params.tasks?.forEach((raw, index) => {
              const result = parseTask(raw);
              if ("error" in result) errors.push(`task[${index}]: ${result.error}`);
              else parsed.push(result);
            });
          });

          if (errors.length > 0) {
            return errorResult(errors.join("\n"), { errors });
          }

          if (params.background === true) {
            const batch = agentManager.startBatch(ctx, signal, parsed, update => {
              updateSubagentWidget(ctx, update.sessions, settings);
            }, { background: true });
            batch.resultsPromise.catch(() => {});
            updateSubagentWidget(ctx, batch.sessions, settings);
            return toolResult(backgroundStartedDetails(batch.sessions));
          }

          const runEnd = timingStart("tool.agentManager.run", { taskCount: parsed.length });
          const batch = agentManager.startBatch(ctx, signal, parsed, update => {
            timingMark("tool.update.received", { sessionCount: update.sessions.length, active: update.active });
            const partial = timingSync("tool.update.partialToolResult", { sessionCount: update.sessions.length }, () => partialToolResult(update));
            timingSync("tool.update.onUpdate", { textLength: partial.content[0]?.text.length ?? 0 }, () => { onUpdate?.(partial); });
            timingSync("tool.update.widget", { sessionCount: update.sessions.length }, () => updateSubagentWidget(ctx, update.sessions, settings));
          }, { background: false });
          const results = await batch.resultsPromise;
          runEnd({ ok: true, resultCount: results.length });
          timingSync("tool.finalWidget", { sessionCount: agentManager.listSessions().length }, () => updateSubagentWidget(ctx, agentManager.listSessions(), settings));
          const isError = results.some(result => result.status !== "completed");
          return toolResult(runDetails(serializeGroup(batch.sessions), { results }), isError);
        }

        case "results": {
          const { sessionIds } = params;
          if (!validateRemoveSessionIds(sessionIds)) {
            return errorResult("results sessionIds must be an array of strings.");
          }
          if (!validateNonEmptySessionIds(sessionIds)) {
            return errorResult("results sessionIds must be an array of non-empty strings.");
          }
          if (sessionIds.length === 0) {
            return errorResult("results requires at least one sessionId.");
          }
          const results = await agentManager.backgroundResults(sessionIds, { remove: params.remove === true });
          return toolResult(backgroundResultsDetails(results));
        }

        case "remove": {
          const { sessionIds, scope } = params;
          const hasIds = sessionIds !== undefined;
          const hasScope = scope !== undefined;
          if (hasIds && hasScope) return errorResult("remove requires exactly one of sessionIds or scope.");
          if (!hasIds && !hasScope) return errorResult("remove requires either sessionIds or scope.");
          if (hasIds && !validateRemoveSessionIds(sessionIds)) {
            return errorResult("remove sessionIds must be an array of strings.");
          }
          if (hasScope && !isRemoveScope(scope)) {
            return errorResult('remove scope must be "background", "retained", or "non-running".');
          }
          const summary = hasIds
            ? await agentManager.remove({ sessionIds })
            : await agentManager.remove({ scope: scope! });
          return toolResult({ view: "remove-summary", summary });
        }

        default:
          return errorResult(`Unknown action: ${String(params.action)}. Use "agents", "list", "run", "results", or "remove".`);
      }
    },
  }));
}
