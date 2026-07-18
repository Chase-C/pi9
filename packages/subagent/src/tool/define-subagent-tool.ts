import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { parseSubagentInvocation, SubagentParams } from "../schema.js";
import type { SubagentSettings } from "../config/settings.js";
import type { SubagentDetails } from "../view/details.js";
import {
  agentsAction,
  listAction,
  removeAction,
  joinAction,
  runAction,
  invocationErrorResult,
  type ActionDeps,
} from "./actions.js";

interface SubagentRenderState {}

/** Adds the ordered task count to run call titles. */
function callSuffix(args: any): string {
  const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
  return tasks.length ? `  ${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "";
}

export interface SubagentToolDeps {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  getCurrentSettings: () => SubagentSettings;
  /**
   * Called at the start of every tool invocation. Root extensions use this to reload settings,
   * reconfigure display, set max-concurrent, and reload the registry. Child factories provide
   * a no-op here because the parent's invocation already performed all of those steps.
   */
  prepareInvocation: (ctx: ExtensionContext) => Promise<SubagentSettings>;
  /** Releases notifier claims made by tool_execution_start after every join exit path. */
  releaseJoinClaims?: (runIds: readonly string[]) => void;
  /** Set on child factories; links spawned conversations and suspends its queue slot while joining. */
  parentConversationId?: string;
  parentRunId?: () => string;
}


export function defineSubagentTool(deps: SubagentToolDeps) {
  const { agentManager, agentRegistry, getCurrentSettings, prepareInvocation, parentConversationId, parentRunId } = deps;
  const actionDeps: ActionDeps = parentConversationId !== undefined
    ? { agentManager, agentRegistry, getCurrentSettings, parentConversationId, ...(parentRunId ? { parentRunId } : {}) }
    : { agentManager, agentRegistry, getCurrentSettings };

  return defineTool<typeof SubagentParams, SubagentDetails, SubagentRenderState>({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate work through context-isolated subagent conversations and runs. Subagents share the working filesystem.",
      "Actions:",
      "  `agents` lists available agent definitions",
      "  `list` returns a flat run inventory, optionally filtered by `status`",
      "  `run` starts spawn (`agent`) or resume (`conversationId`) tasks and immediately returns run IDs",
      "  `join` waits for exact `runIds` and returns their ordered full outcomes",
      "  `remove` explicitly removes `conversationIds`",
    ].join("\n"),
    promptSnippet: "Delegate bounded work to context-isolated subagents",
    promptGuidelines: [
      "Use subagent for bounded work that benefits from specialization, parallelism, or a fresh context.",
      "Skip subagent when delegation overhead exceeds doing the work directly, or when its output cannot be verified or consumed without repeating the work.",
      "Call subagent action=agents before choosing an agent unless the user named one explicitly or definitions were already listed.",
      "Subagents spawn with no knowledge of the parent conversation — the prompt is everything they receive, so include all information the task requires.",
      "Use join with returned runIds when the child results are needed.",
    ],
    parameters: SubagentParams,
    renderCall(args, theme, context) {
      const action = typeof args?.action === "string" ? args.action : "pending";
      const title = theme?.bold ? theme.bold("subagent") : "subagent";
      const label = `${title} ${action}`;
      const suffix = callSuffix(args);
      const styledLabel = theme?.fg ? theme.fg("toolTitle", label) : label;
      const styledSuffix = theme?.fg ? theme.fg("dim", suffix) : suffix;
      return new Text(`${styledLabel}${styledSuffix}`, 0, 0);
    },
    renderResult(result) {
      const part = result.content.find(entry => entry.type === "text");
      const text = part && "text" in part ? part.text : "";
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const requestedJoinIds = params?.action === "join" && Array.isArray(params.runIds)
        ? params.runIds.filter((id): id is string => typeof id === "string")
        : [];
      try {
        const settings = await prepareInvocation(ctx);

        const invocation = parseSubagentInvocation(params, { maxTasks: settings.runtime.maxTasksPerRun });
        if ("error" in invocation) return invocationErrorResult(actionDeps, invocation);

        switch (invocation.action) {
          case "agents": return agentsAction(actionDeps, invocation);
          case "list": return listAction(actionDeps, invocation);
          case "join": return joinAction(actionDeps, invocation, signal, onUpdate);
          case "remove": return removeAction(actionDeps, invocation);
          case "run": return runAction(actionDeps, invocation, ctx);
        }
      } finally {
        if (requestedJoinIds.length) deps.releaseJoinClaims?.(requestedJoinIds);
      }
    },
  });
}
