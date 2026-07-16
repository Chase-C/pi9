import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { parseSubagentInvocation, SubagentParams } from "../schema.js";
import type { SubagentSettings } from "../config/settings.js";
import { createSubagentTextComponent, runSummary, type RunSummary, type SubagentDetails } from "../view/format.js";
import {
  agentsAction,
  listAction,
  removeAction,
  resultsAction,
  runAction,
  invocationErrorResult,
  type ActionDeps,
} from "./actions.js";

/** Row-local renderer state shared across a single tool call's renderResult and renderCall. */
interface SubagentRenderState {
  runSummary?: RunSummary;
}

/**
 * The trailing summary for a tool-call title. Whenever a live summary is present (a `run` or its
 * completed `results`), it shows the subagent counts and elapsed time — `running`/`queued` only
 * when above zero, `finished` and elapsed always. Otherwise (no summary yet, or a view that yields
 * none) it falls back to the task count so the first title render stays useful before any result.
 */
function callSuffix(summary: RunSummary | undefined, args: any): string {
  if (summary) {
    const counts = [
      ...(summary.running > 0 ? [`${summary.running} running`] : []),
      ...(summary.queued > 0 ? [`${summary.queued} queued`] : []),
      `${summary.finished} finished`,
      summary.elapsed,
    ];
    return `  ${counts.join(" · ")}`;
  }
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
  /** Set on child factories; threaded into manager.startRun so spawned agents are linked. */
  parentSessionId?: string;
}


export function defineSubagentTool(deps: SubagentToolDeps) {
  const { agentManager, agentRegistry, getCurrentSettings, prepareInvocation, parentSessionId } = deps;
  const actionDeps: ActionDeps = parentSessionId !== undefined
    ? { agentManager, agentRegistry, getCurrentSettings, parentSessionId }
    : { agentManager, agentRegistry, getCurrentSettings };

  return defineTool<typeof SubagentParams, SubagentDetails, SubagentRenderState>({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate work to context-isolated subagent sessions. Subagents share the working filesystem.",
      "Actions:",
      "  `agents` lists available agent definitions",
      "  `list` returns lightweight session status, optionally filtered by `status`",
      "  `run` spawns (`agent`) or resumes (`sessionId`) tasks; multiple tasks run concurrently",
      "  `results` returns full output/errors for sessionIds without waiting; `remove: true` also deletes terminal sessions",
      "  `remove` aborts active sessions and discards queued/terminal sessions",
    ].join("\n"),
    promptSnippet: "Delegate bounded work to context-isolated subagents",
    promptGuidelines: [
      "Use subagent for bounded work that benefits from specialization, parallelism, or a fresh context.",
      "Skip subagent when delegation overhead exceeds doing the work directly, or when its output cannot be verified or consumed without repeating the work.",
      "Call subagent action=agents before choosing an agent unless the user named one explicitly or definitions were already listed.",
      "Subagents spawn with no knowledge of the parent conversation — the prompt is everything they receive, so include all information the task requires.",
      "Use subagent background=true only when the parent has independent work to continue; otherwise prefer foreground results.",
    ],
    parameters: SubagentParams,
    renderCall(args, theme, context) {
      const action = typeof args?.action === "string" ? args.action : "pending";
      const summary = context?.state?.runSummary;
      const title = theme?.bold ? theme.bold("subagent") : "subagent";
      const label = `${title} ${action}`;
      const suffix = callSuffix(summary, args);
      const styledLabel = theme?.fg ? theme.fg("toolTitle", label) : label;
      const styledSuffix = theme?.fg ? theme.fg("dim", suffix) : suffix;
      return new Text(`${styledLabel}${styledSuffix}`, 0, 0);
    },
    renderResult(result, options, theme, context) {
      try {
        // Share the live run summary so renderCall can title the row with counts + elapsed. Derived
        // here because the result renderer is the only one that sees the live `run` details; kept
        // inside the try so a malformed payload falls back to plain text like component creation.
        if (context?.state) {
          const summary = runSummary(result.details);
          if (summary) context.state.runSummary = summary;
        }
        const component = createSubagentTextComponent(result.details, Boolean(options.expanded), theme, undefined, getCurrentSettings().display);
        if (component) return component;
      } catch { }
      const part = result.content.find(entry => entry.type === "text");
      const text = part && "text" in part ? part.text : "";
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const settings = await prepareInvocation(ctx);

      const invocation = parseSubagentInvocation(params, { maxTasks: settings.runtime.maxTasksPerRun });
      if ("error" in invocation) return invocationErrorResult(actionDeps, invocation);

      switch (invocation.action) {
        case "agents": return agentsAction(actionDeps, invocation);
        case "list": return listAction(actionDeps, invocation);
        case "results": return resultsAction(actionDeps, invocation, ctx);
        case "remove": return removeAction(actionDeps, invocation, ctx);
        case "run": return runAction(actionDeps, invocation, signal, onUpdate, ctx);
      }
    },
  });
}
