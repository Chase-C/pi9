import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { timingMark } from "../runtime/timing.js";
import { SubagentParams } from "../schema.js";
import type { SubagentSettings } from "../ui/settings.js";
import { createSubagentTextComponent } from "../view/format.js";
import { configureSubagentDisplay, getSubagentDisplaySettings } from "../view/view-helpers.js";
import {
  agentsAction,
  errorResult,
  listAction,
  removeAction,
  resultsAction,
  runAction,
  type ActionDeps,
} from "./actions.js";

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

const TOOL_DESCRIPTION = `Delegate focused work to a specialized subagent in an isolated context window. Your prompt is the subagent's only context (beyond its system prompt), so include everything it needs: objective, files/dirs, constraints, output format.

Delegate when:
- the work would otherwise crowd this conversation (large searches/reads, or long-running work with a clean summary back)
- the work benefits from independent context (e.g. a reviewer)

Skip delegation when:
- you would finish it in a handful of tool calls, given the context you already have
- using the subagent's output would require redoing the work yourself

When the user names a specific agent, immediately call { action: "run" }. Otherwise, call { action: "agents" } and pick one whose tools/skills/prompt fit — if nothing fits, do the work yourself.

Call shapes:

  { action: "agents" } — list known agents
  { action: "list", status?: [SessionStatus, ...] } — list active and retained sessions
  { action: "run", background?: boolean, tasks: [SpawnTask | ResumeTask, ...] } — spawn or resume tasks (in parallel)
  { action: "results", sessionIds: [string, ...], remove?: boolean } — fetch output (set \`remove: true\` to sweep)
  { action: "remove", sessionIds: [string, ...] } — remove specific sessions (running ones abort)
  { action: "remove", scope: Scope } — remove all sessions matching a scope

  SpawnTask     = { agent, prompt, label?, resumable?, model?, thinking?, cwd?, skills? }
  ResumeTask    = { sessionId, prompt, label?, resumable? }
  SessionStatus = "queued" | "running"                                            // active
                | "completed" | "error" | "aborted" | "interrupted" | "skipped"   // terminal
  Scope         = "background"    // background-dispatched sessions
                | "retained"      // resumable foreground sessions kept after completion
                | "non-running"   // everything except currently-running sessions
`;

export function defineSubagentTool(deps: SubagentToolDeps) {
  const { agentManager, agentRegistry, getCurrentSettings, prepareInvocation, parentSessionId } = deps;
  const actionDeps: ActionDeps = parentSessionId !== undefined
    ? { agentManager, agentRegistry, getCurrentSettings, parentSessionId }
    : { agentManager, agentRegistry, getCurrentSettings };

  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: TOOL_DESCRIPTION,
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
      timingMark("tool.execute.start", { action: params.action, taskCount: Array.isArray(params.tasks) ? params.tasks.length : undefined, cwd: ctx.cwd, isChild: parentSessionId !== undefined });
      const settings = await prepareInvocation(ctx);
      configureSubagentDisplay(settings.display);

      if (!params.action) {
        return errorResult(`Provide an action: "agents", "list", "run", "results", or "remove".\n\nAvailable agents:\n${agentRegistry.summarizeAgent()}`);
      }

      switch (params.action) {
        case "agents": return agentsAction(actionDeps);
        case "list": return listAction(actionDeps, params);
        case "results": return resultsAction(actionDeps, params);
        case "remove": return removeAction(actionDeps, params);
        case "run": return runAction(actionDeps, params, signal, onUpdate, ctx, settings);
        default:
          return errorResult(`Unknown action: ${String(params.action)}. Use "agents", "list", "run", "results", or "remove".`);
      }
    },
  });
}
