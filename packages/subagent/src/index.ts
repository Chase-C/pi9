import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { AgentRegistry } from "./domain/agent-registry.js";
import type { SubagentBatchUpdate } from "./domain/agent-view.js";
import { AgentManager } from "./runtime/agent-manager.js";
import { timingAsync, timingMark, timingStart, timingSync } from "./runtime/timing.js";
import { parseTask, SubagentParams, type TaskRequest } from "./schema.js";
import { SubagentUiSettingsStore, DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./ui/settings.js";
import { loadSubagentUiSettings, updateSubagentWidget } from "./ui/widget.js";
import { registerSubagentsCommand } from "./command/register.js";
import {
  agentsDetails,
  createSubagentTextComponent,
  formatSubagentToolLines,
  inventoryDetails,
  runDetails,
} from "./view/format.js";
import { formatSubagentResumeMessageContent } from "./view/resume-message.js";
import { configureSubagentDisplay, getSubagentDisplaySettings } from "./view/view-helpers.js";
import { listAgentDefinitions, listSkills, serializeGroup } from "./view/serialize.js";


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
- action: one of "list", "run", or "remove".
- action="list": list configured agent definitions by default. Pass type="sessions" to list active and retained subagent sessions instead of definitions, or type="skills" to list skills available to inject. Listed agents include any default skills declared in their frontmatter alongside their tools.
- action="run": run one or more subagent tasks up to the configured maxTasksPerRun (default eight). Each task is either a new spawn (carrying agent) or a resume of a completed resumable session (carrying sessionId). agent and sessionId are mutually exclusive — providing both is rejected. A spawn task takes agent and prompt and may include cwd, model, thinking, label, resumable, and skills. A resume task takes sessionId and prompt and may re-assert label and resumable; it rejects model, thinking, cwd, agent, and skills. The optional label is a human-readable identifier shown in widgets and logs in place of the agent name; on resume it overwrites the stored label. The optional resumable override applies one-way at completion: a resumable: false decision discards the session immediately, regardless of the agent's frontmatter default. The optional skills array (spawn only) injects named skills into the subagent's system prompt — unknown skill names are a hard error and an explicit skill bypasses its disable-model-invocation flag. Per-task skills fully replace the agent's default skills declared in frontmatter (no merge); an explicit empty array opts out of those defaults.
- action="remove": remove subagent sessions by id or scope. Pass exactly one of sessionIds (an array of known session ids) or scope ("background" | "retained" | "non-running"). Running sessions in the targeted set are aborted before removal. Unknown ids surface as per-id errors in the response without setting isError; the overall remove call succeeds. Bare or conflicting calls are rejected.

Prompt guidance:
- Name the exact objective, relevant files/directories, constraints, and expected output format.
- Include enough context for the subagent to work without reading the parent conversation.
- Prefer one writer task at a time. Parallel tasks should be independent and should not edit the same files unless the user explicitly requested that workflow.

Execution notes:
- Up to maxConcurrentSubagents run tasks execute concurrently (default four); final results preserve input order.
- run is blocking and returns structured results when each child prompt completes. Each result carries a resumed flag distinguishing fresh spawns from resumed sessions.
- Results include a resumable flag and a sessionId when a resumable child has or had a child AgentSession; only completed resumable sessions can be resumed.
- Resumable sessions live for the current Pi process lifetime or until cleared.
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
        return errorResult(`Provide an action: "list", "run", or "remove".\n\nAvailable agents:\n${agentRegistry.summarizeAgent()}`);
      }

      if (params.action === "list") {
        const type = params.type ?? "agents";
        switch (type) {
          case "agents": return toolResult(agentsDetails(listAgentDefinitions(agentRegistry)));
          case "sessions": return toolResult(inventoryDetails(agentManager.sessions));
          case "skills": return toolResult({ skills: listSkills(ctx.cwd) });
          default: return errorResult('For action=list, type must be "agents", "sessions", or "skills".');
        }
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
        timingSync("tool.finalWidget", { sessionCount: agentManager.sessions.length }, () => updateSubagentWidget(ctx, agentManager.sessions, settings));
        const isError = results.some(result => result.status !== "completed");
        const details = lastGroup ? runDetails(lastGroup, { results }) : { results };
        return toolResult(details, isError);
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
        const summary = hasIds
          ? await agentManager.remove({ sessionIds: sessionIds as string[] })
          : await agentManager.remove({ scope: scope as "background" | "retained" | "non-running" });
        return toolResult({ view: "remove-summary", summary });
      }

      return errorResult(`Unknown action: ${String(params.action)}. Use "list", "run", or "remove".`);
    },
  }));
}
