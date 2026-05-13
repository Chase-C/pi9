import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { AgentRegistry } from "./domain/agent-registry.js";
import type { SubagentBatchUpdate } from "./domain/agent-view.js";
import { AgentManager } from "./runtime/agent-manager.js";
import { timingAsync, timingMark, timingStart, timingSync } from "./runtime/timing.js";
import { isSessionStatus, parseTask, SESSION_STATUSES, SubagentParams, type SessionStatus, type TaskRequest } from "./schema.js";
import { SubagentUiSettingsStore, DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./ui/settings.js";
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

type RemoveScope = "background" | "retained" | "non-running";

function isRemoveScope(scope: unknown): scope is RemoveScope {
  return scope === "background" || scope === "retained" || scope === "non-running";
}

function validateRemoveSessionIds(sessionIds: unknown): sessionIds is string[] {
  return Array.isArray(sessionIds) && sessionIds.every(id => typeof id === "string");
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

function applySettings(agentManager: AgentManager, settings: SubagentSettings) {
  configureSubagentDisplay(settings.display);
  agentManager.configure?.({ maxRunning: settings.runtime.maxConcurrentSubagents });
}

function partialToolResult(update: SubagentBatchUpdate) {
  const details = runDetails(serializeGroup(update.sessions), { active: update.active });
  return {
    content: [{ type: "text" as const, text: formatSubagentToolLines(details, true).join("\n") }],
    details,
  };
}

function simpleTextFromToolResult(result: any) {
  const textContent = Array.isArray(result?.content)
    ? result.content.find((part: any) => part?.type === "text" && typeof part.text === "string")?.text
    : undefined;
  if (textContent) return textContent;
  try {
    return JSON.stringify(result?.details ?? result ?? {}, null, 2);
  } catch {
    return String(result ?? "");
  }
}

export default function subagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}) {
  const agentRegistry = dependencies.agentRegistry ?? new AgentRegistry();
  const agentManager = dependencies.agentManager ?? new AgentManager(agentRegistry);
  const settingsStore = dependencies.settingsStore ?? new SubagentUiSettingsStore();

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
    description: `Delegate focused work to specialized subagents running in isolated context windows.

Use this tool when a task benefits from separation from the main conversation: code research, planning, design review, bug investigation, test analysis, or a focused implementation handoff. Each subagent receives only its configured system prompt plus the prompt you provide, so prompts must be self-contained.

Inputs:
- action: one of "agents", "list", "run", "results", or "remove".
- action="agents": list configured agent definitions. Each entry carries the agent's tools and any default skills declared in its frontmatter. Takes no other parameters.
- action="list": list active and retained subagent sessions. Optional status: an array of session statuses ("queued" | "running" | "completed" | "error" | "aborted" | "interrupted" | "skipped") that filters the result; an empty array returns no sessions. Each row carries a kind tag ("background" | "retained") describing how it was dispatched. The legacy type parameter has been removed; passing it returns a migration error. Skills listing is no longer exposed through this tool.
- action="run": run one or more subagent tasks up to the configured maxTasksPerRun (default eight). Each task is either a new spawn (carrying agent) or a resume of a completed resumable session (carrying sessionId). agent and sessionId are mutually exclusive — providing both is rejected. A spawn task takes agent and prompt and may include cwd, model, thinking, label, resumable, and skills. A resume task takes sessionId and prompt and may re-assert label and resumable; it rejects model, thinking, cwd, agent, and skills. The optional label is a human-readable identifier shown in widgets and logs in place of the agent name; on resume it overwrites the stored label. The optional resumable override applies one-way at completion: a resumable: false decision discards the session immediately, regardless of the agent's frontmatter default. The optional skills array (spawn only) injects named skills into the subagent's system prompt — unknown skill names are a hard error and an explicit skill bypasses its disable-model-invocation flag. Per-task skills fully replace the agent's default skills declared in frontmatter (no merge); an explicit empty array opts out of those defaults. An optional batch-level background: true flag dispatches the run non-blocking; the call returns immediately with initial session views and the children continue under a manager-owned controller. Background results persist until removed or collected — call \`subagent results\` to retrieve and either pass remove: true or call \`subagent remove\` afterward. Per-task background is rejected with a migration error.
- action="results": retrieve background results by session id. Pass sessionIds (a non-empty array of strings). The call never blocks: terminal entries return their full AgentRunResult under { ready: true, result }, queued/running entries return { ready: false, status, elapsedMs, agent, label? }, and unknown ids return per-id error entries without setting isError on the overall response. Pass remove: true to sweep terminal entries after their result is returned; running entries are never removed regardless of the flag. The action is not background-only: a retained resumable session id returns its result the same way.
- action="remove": remove subagent sessions by id or scope. Pass exactly one of sessionIds (an array of known session ids) or scope ("background" | "retained" | "non-running"). Running sessions in the targeted set are aborted before removal. Unknown ids surface as per-id errors in the response without setting isError; the overall remove call succeeds. Bare or conflicting calls are rejected.

Prompt guidance:
- Name the exact objective, relevant files/directories, constraints, and expected output format.
- Include enough context for the subagent to work without reading the parent conversation.
- Prefer one writer task at a time. Parallel tasks should be independent and should not edit the same files unless the user explicitly requested that workflow.

Execution notes:
- Up to maxConcurrentSubagents run tasks execute concurrently (default four); final results preserve input order.
- run is blocking and returns structured results when each child prompt completes. Each result carries a resumed flag distinguishing fresh spawns from resumed sessions.
- Results include a resumable flag and a sessionId when a resumable child has or had a child AgentSession; only completed resumable sessions can be resumed.
- Resumable sessions live for the current Pi process lifetime or until removed.
- Unknown agents and unknown sessionIds surface as per-task error results (with resumed set accordingly) and do not prevent sibling tasks from running.
`,
    promptSnippet: "Delegate focused tasks to specialized subagents with separate context windows",
    promptGuidelines: [
      "Use subagent for independent research, planning, review, or implementation tasks that would benefit from isolated context.",
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
      return new Text(simpleTextFromToolResult(result), 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      timingMark("tool.execute.start", { action: params.action, taskCount: Array.isArray(params.tasks) ? params.tasks.length : undefined, cwd: ctx.cwd });
      const settings = await timingAsync("tool.loadSettings", { hasUI: ctx.hasUI }, () => loadSubagentUiSettings(ctx, settingsStore));
      applySettings(agentManager, settings);
      await timingAsync("tool.agentRegistry.reload", { cwd: ctx.cwd }, () => agentRegistry.reload(ctx.cwd, {
        discovery: settings.agentDiscovery,
        defaultResumable: settings.runtime.defaultResumable,
        onWarning: message => ctx.ui?.notify?.(message, "warning"),
      }));

      if (!params.action) {
        return errorResult(`Provide an action: "agents", "list", "run", "results", or "remove".\n\nAvailable agents:\n${agentRegistry.summarizeAgent()}`);
      }

      if (params.action === "agents") {
        return toolResult(agentsDetails(listAgentDefinitions(agentRegistry)));
      }

      if (params.action === "list") {
        if ((params as { type?: unknown }).type !== undefined) {
          return errorResult("The 'type' parameter has been removed. Use action: 'agents' to list definitions, or action: 'list' (optionally with status: [...]) for sessions. Skills listing is no longer exposed through the subagent tool.");
        }
        const statusFilter = params.status;
        let filter: { status: SessionStatus[] } | undefined;
        if (statusFilter !== undefined) {
          if (!Array.isArray(statusFilter)) {
            return errorResult("list status must be an array of status strings.");
          }
          for (const value of statusFilter) {
            if (!isSessionStatus(value)) {
              return errorResult(`Unknown status '${String(value)}'. Valid: ${SESSION_STATUSES.join(", ")}.`);
            }
          }
          filter = { status: statusFilter as SessionStatus[] };
        }
        return toolResult(inventoryDetails(agentManager.listSessions(filter), filter));
      }

      if (params.action === "run") {
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

        const background = params.background === true;

        if (background) {
          const batch = agentManager.startBatch(ctx, signal, parsed, update => {
            const partial = partialToolResult(update);
            onUpdate?.(partial);
            updateSubagentWidget(ctx, update.sessions, settings);
          }, { background: true });
          batch.resultsPromise.catch(() => {});
          updateSubagentWidget(ctx, batch.sessions, settings);
          return toolResult(backgroundStartedDetails(batch.sessions));
        }

        let lastGroup: ReturnType<typeof serializeGroup> | undefined;
        const runEnd = timingStart("tool.agentManager.run", { taskCount: parsed.length });
        const results = await agentManager.run(ctx, signal, parsed, update => {
          timingMark("tool.update.received", { sessionCount: update.sessions.length, active: update.active });
          const partial = timingSync("tool.update.partialToolResult", { sessionCount: update.sessions.length }, () => partialToolResult(update));
          lastGroup = partial.details.group;
          timingSync("tool.update.onUpdate", { textLength: partial.content[0]?.text.length ?? 0 }, () => { onUpdate?.(partial); });
          timingSync("tool.update.widget", { sessionCount: update.sessions.length }, () => updateSubagentWidget(ctx, update.sessions, settings));
        });
        runEnd({ ok: true, resultCount: results.length });
        timingSync("tool.finalWidget", { sessionCount: agentManager.listSessions().length }, () => updateSubagentWidget(ctx, agentManager.listSessions(), settings));
        const isError = results.some(result => result.status !== "completed");
        const details = lastGroup ? runDetails(lastGroup, { results }) : { results };
        return toolResult(details, isError);
      }

      if (params.action === "results") {
        const { sessionIds } = params;
        if (!validateRemoveSessionIds(sessionIds)) {
          return errorResult("results sessionIds must be an array of strings.");
        }
        if (sessionIds.length === 0) {
          return errorResult("results requires at least one sessionId.");
        }
        const remove = params.remove === true;
        const results = await agentManager.backgroundResults(sessionIds, { remove });
        return toolResult(backgroundResultsDetails(results));
      }

      if (params.action === "clear") {
        return errorResult("The 'clear' action has been replaced by 'remove'. Pass either { sessionIds: [...] } or { scope: 'background' | 'retained' | 'non-running' }.");
      }

      if (params.action === "remove") {
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

      return errorResult(`Unknown action: ${String(params.action)}. Use "agents", "list", "run", "results", or "remove".`);
    },
  }));
}
