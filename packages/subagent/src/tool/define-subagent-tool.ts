import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { ConversationId } from "../domain/conversation-id.js";
import type { RunId } from "../domain/run-id.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { parseSubagentInvocation, SubagentParams } from "../schema.js";
import type { SubagentSettings } from "../config/settings.js";
import {
  agentsAction,
  listAction,
  removeAction,
  joinAction,
  runAction,
  invocationErrorResult,
  type ActionDeps,
} from "./actions.js";

/** Adds the ordered task count to run call titles. */
function callSuffix(args: any): string {
  const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
  return tasks.length ? `  ${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "";
}

export interface SubagentToolDeps {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  /**
   * Called at the start of every tool invocation. Root extensions use this to reload settings,
   * reconfigure display, set max-concurrent, and reload the registry. Child factories provide
   * a no-op here because the parent's invocation already performed all of those steps.
   */
  prepareInvocation: (ctx: ExtensionContext) => Promise<SubagentSettings>;
  /** Releases notifier claims made by tool_execution_start after every join exit path. */
  releaseJoinClaims?: (runIds: readonly string[]) => void;
  /** Set on child factories; links spawned conversations and suspends its queue slot while joining. */
  parent?: { conversationId: ConversationId; runId: () => RunId };
}


export function defineSubagentTool(deps: SubagentToolDeps) {
  const { agentManager, agentRegistry, prepareInvocation, parent } = deps;
  const actionDeps: ActionDeps = { agentManager, agentRegistry, ...(parent ? { parent } : {}) };

  return defineTool<typeof SubagentParams, undefined>({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate work through context-isolated subagent conversations and runs. Subagents share the working filesystem.",
      "Actions:",
      "  agents(): List available agent definitions.",
      "  list(status?): List runs, optionally filtered by status.",
      "  run(tasks): Start asynchronous parallel tasks and immediately return their run IDs.",
      "  join(runIds): Wait for the given runs and return their outcomes in the same order.",
      "  remove(conversationIds): Remove retained conversations.",
      "Tasks:",
      "  Spawn: { agent, prompt, label?, skills?, model?, thinking?, cwd? }",
      "  Resume: { conversationId, prompt }",
    ].join("\n"),
    promptSnippet: "Delegate bounded work to context-isolated subagents",
    promptGuidelines: [
      "Delegate bounded, self-contained units of work to subagent — work that parallelizes cleanly, deserves a specialist, or benefits from a fresh context.",
      "Skip subagent when delegating costs more than doing, or when you couldn't verify or use the result without repeating the work.",
      "Write each subagent prompt as if to a stranger sharing only your filesystem: every input, path, and constraint, plus what to report back or produce.",
      "Run subagent tasks in parallel only when they're independent and won't interact with the same files; join once you depend on their results or have nothing else to do.",
      "Resume a retained subagent when its context helps the follow-up, spawn fresh when it wouldn't help or would mislead, and remove any you won't need again.",
      //"Call subagent action=agents before choosing an agent unless the user named one explicitly or definitions were already listed.",
    ],
    parameters: SubagentParams,
    renderCall(args, theme) {
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
