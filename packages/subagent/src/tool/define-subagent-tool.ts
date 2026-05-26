import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import { SubagentParams } from "../schema.js";
import type { SubagentSettings } from "../config/settings.js";
import { createSubagentTextComponent, runSummary, type RunSummary, type SubagentDetails } from "../view/format.js";
import {
  agentsAction,
  errorResult,
  listAction,
  removeAction,
  resultsAction,
  runAction,
  type ActionDeps,
} from "./actions.js";

/** Row-local renderer state shared across a single tool call's renderResult and renderCall. */
interface SubagentRenderState {
  runSummary?: RunSummary;
}

/**
 * The `· …` suffix for a tool-call title. Whenever a live summary is present (a `run` or its
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
    return ` · ${counts.join(" · ")}`;
  }
  const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
  return tasks.length ? ` · ${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "";
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

  return defineTool<typeof SubagentParams, SubagentDetails, SubagentRenderState>({
    name: "subagent",
    label: "Subagent",
    description: TOOL_DESCRIPTION,
    parameters: SubagentParams,
    renderCall(args, theme: any, context) {
      const action = typeof args?.action === "string" ? args.action : "pending";
      const summary = context?.state?.runSummary;
      const line = `subagent ${action}${callSuffix(summary, args)}`;
      return new Text(theme?.fg ? theme.fg("toolTitle", line) : line, 0, 0);
    },
    renderResult(result, options, theme: any, context) {
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
