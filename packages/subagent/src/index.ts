import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { AgentManager, AgentOptions } from "./agent-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import { SubagentParams } from "./schema.js";
import { SubagentUiSettingsStore } from "./subagent-settings.js";
import { registerSubagentsCommand } from "./subagents-command.js";
import { loadSubagentUiSettings, updateSubagentWidget } from "./subagent-widget.js";
import {
  agentConfigToDefinitionDto,
  createSubagentGroupDto,
  createSubagentTextComponent,
  formatSubagentResumeMessageContent,
  formatSubagentToolLines,
  type SubagentGroupDto,
} from "./subagent-ui.js";

const MAX_TASKS = 8;

interface SubagentExtensionDependencies {
  agentRegistry?: AgentRegistry;
  agentManager?: AgentManager;
  settingsStore?: Pick<SubagentUiSettingsStore, "load" | "save">;
}

function validateTasks(tasks: SubagentParams["tasks"] | undefined) {
  if (!Array.isArray(tasks)) return "Provide a tasks array for action=start.";
  if (tasks.length === 0) return "Provide at least one task.";
  if (tasks.length > MAX_TASKS) return `Too many tasks (${tasks.length}). Max is ${MAX_TASKS}.`;
  return undefined;
}

function validateString(value: unknown, name: string) {
  if (typeof value !== "string" || value.trim() === "") return `Provide a non-empty ${name}.`;
  return undefined;
}

function listAgentDefinitions(agentRegistry: AgentRegistry) {
  return Array.from(agentRegistry.agents.values()).map(agentConfigToDefinitionDto);
}

function toolResult(details: Record<string, unknown>, isError = false) {
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

function partialToolResult(group: SubagentGroupDto, active: boolean) {
  const details = { group, sessions: group.sessions, active };
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
    (pi as ExtensionAPI & { registerMessageRenderer?: ExtensionAPI["registerMessageRenderer"] }).registerMessageRenderer?.("subagent-resume", (message, _options, theme) => {
      const content = typeof message.content === "string"
        ? message.content
        : formatSubagentResumeMessageContent(message.details as any);
      try {
        return new Text(theme?.fg ? theme.fg("customMessageText", content) : content, 0, 0);
      } catch {
        return new Text(content, 0, 0);
      }
    });
  } catch { }

  pi.registerTool(defineTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate focused work to specialized subagents running in isolated context windows.

Use this tool when a task benefits from separation from the main conversation: code research, planning, design review, bug investigation, test analysis, or a focused implementation handoff. Each subagent receives only its configured system prompt plus the prompt you provide, so prompts must be self-contained.

Inputs:
- action: one of "list", "start", "resume", or "clear".
- action="list": list configured agent definitions by default. Pass type="sessions" to list retained resumable subagent sessions instead of definitions.
- action="start": run one to eight independent delegations. Each task requires an agent name and prompt, and can include cwd to run from a different directory relative to the current project.
- action="resume": send a follow-up prompt to a completed resumable subagent session by sessionId.
- action="clear": release one retained resumable session by sessionId, or all retained sessions when sessionId is omitted.

Prompt guidance:
- Name the exact objective, relevant files/directories, constraints, and expected output format.
- Include enough context for the subagent to work without reading the parent conversation.
- Prefer one writer task at a time. Parallel tasks should be independent and should not edit the same files unless the user explicitly requested that workflow.

Execution notes:
- Up to four start tasks run concurrently; final results preserve input order.
- start and resume are blocking and return structured results when the child prompt completes.
- start returns sessionId only for agents whose definition has resumable: true and whose initial prompt completed successfully.
- Resumable sessions live for the current Pi process lifetime or until cleared.
- Unknown agents and failed subagents are reported as failed runs and do not prevent other scheduled start tasks from completing.
`,
    promptSnippet: "Delegate focused tasks to specialized subagents with separate context windows",
    promptGuidelines: [
      "Use subagent for independent research, planning, review, or implementation tasks that would benefit from isolated context.",
    ],
    parameters: SubagentParams,
    renderCall(args: any, theme: any) {
      const action = typeof args?.action === "string" ? args.action : "pending";
      const count = Array.isArray(args?.tasks) ? args.tasks.length : undefined;
      const suffix = count ? ` · ${count} task${count === 1 ? "" : "s"}` : "";
      const line = `subagent ${action}${suffix}`;
      try {
        return new Text(theme?.fg ? theme.fg("toolTitle", line) : line, 0, 0);
      } catch {
        return new Text(line, 0, 0);
      }
    },
    renderResult(result: any, options: any, theme: any) {
      try {
        return createSubagentTextComponent(result?.details, Boolean(options?.expanded), theme);
      } catch {
        return new Text(simpleTextFromToolResult(result), 0, 0);
      }
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      await agentRegistry.reload(ctx.cwd);

      if (!params.action) {
        return errorResult(`Provide an action: "list", "start", "resume", or "clear".\n\nAvailable agents:\n${agentRegistry.summarizeAgent()}`);
      }

      if (params.action === "list") {
        const type = params.type ?? "agents";
        if (type === "agents") {
          const agents = listAgentDefinitions(agentRegistry);
          return toolResult({ agents });
        }
        if (type === "sessions") {
          const sessions = agentManager.sessions;
          return toolResult({ sessions });
        }
        return errorResult('For action=list, type must be "agents" or "sessions".');
      }

      if (params.action === "start") {
        const validationError = validateTasks(params.tasks);

        if (validationError) {
          return errorResult(`${validationError}\n\nAvailable agents:\n${agentRegistry.summarizeAgent()}`);
        }

        const options = params.tasks as Array<AgentOptions>;
        const uiSettings = await loadSubagentUiSettings(ctx, settingsStore);
        let lastGroup: SubagentGroupDto | undefined;
        const results = await agentManager.spawn(pi, ctx, signal, options, update => {
          const group = update.group ?? createSubagentGroupDto(update.groupId ?? "subagent", Date.now(), update.sessions);
          lastGroup = group;
          onUpdate?.(partialToolResult(group, update.active));
          updateSubagentWidget(ctx, update.sessions, uiSettings);
        });
        updateSubagentWidget(ctx, agentManager.sessions, uiSettings);
        const isError = results.some(result => result.status !== "completed");
        const sessions = lastGroup?.sessions ?? agentManager.sessions;
        return toolResult({ results, group: lastGroup, sessions }, isError);
      }

      if (params.action === "resume") {
        const sessionIdError = validateString(params.sessionId, "sessionId");
        if (sessionIdError) return errorResult(sessionIdError);
        const promptError = validateString(params.prompt, "prompt");
        if (promptError) return errorResult(promptError);

        try {
          const uiSettings = await loadSubagentUiSettings(ctx, settingsStore);
          let lastGroup: SubagentGroupDto | undefined;
          const result = await agentManager.resume(ctx, signal, params.sessionId!, params.prompt!, update => {
            const group = update.group ?? createSubagentGroupDto(update.groupId ?? "subagent", Date.now(), update.sessions);
            lastGroup = group;
            onUpdate?.(partialToolResult(group, update.active));
            updateSubagentWidget(ctx, update.sessions, uiSettings);
          });
          updateSubagentWidget(ctx, agentManager.sessions, uiSettings);
          return toolResult({ result, group: lastGroup, sessions: lastGroup?.sessions ?? agentManager.sessions }, result.status !== "completed");
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error), { sessionId: params.sessionId });
        }
      }

      if (params.action === "clear") {
        if (params.sessionId !== undefined && typeof params.sessionId !== "string") {
          return errorResult("sessionId must be a string when provided.");
        }

        const result = agentManager.clear(params.sessionId);
        if (params.sessionId && result.cleared === 0) {
          return errorResult(`Unknown resumable subagent session: ${params.sessionId}`, result);
        }
        return toolResult(result);
      }

      return errorResult(`Unknown action: ${String(params.action)}. Use "list", "start", "resume", or "clear".`);
    },
  }));
}
