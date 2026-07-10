import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { toResult, type AgentResult } from "../../src/domain/agent-result.js";
import { AgentManager, type AgentRunner, type RunUpdateListener } from "../../src/runtime/agent-manager.js";
import type { TaskRequest } from "../../src/schema.js";

/**
 * Builds a real AgentManager with parent-finalize cancellation wired up (it's instance-owned
 * after the runtime refactor). Mirrors what `subagentExtension` builds in production.
 */
export function makeManager(
  registry: any,
  maxRunning: number = 4,
  runner?: AgentRunner,
): AgentManager {
  return new AgentManager(registry, maxRunning, runner);
}

/**
 * Foreground convenience: starts a run, awaits the terminal snapshots, and projects each
 * through `toResult` — mirroring what the tool layer returns to the model.
 */
export function run(
  manager: AgentManager,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  tasks: TaskRequest[],
  onUpdate?: RunUpdateListener,
  options: { parentId?: string } = {},
): Promise<AgentResult[]> {
  return manager.startRun(ctx, signal, tasks, onUpdate, { background: false, ...options })
    .resultsPromise.then(snapshots => snapshots.map(toResult));
}

export const baseCtx = () => ({ cwd: process.cwd(), modelRegistry: { getAll: () => [] } } as any);

export const makeSession = () => ({
  messages: [] as any[],
  subscribe: () => () => {},
  prompt: async () => {},
  abort: () => {},
});

/** Pick the resume or spawn runner based on attempt kind. */
export const mergeRunners = (
  spawn: (ctx: any, agent: any, attempt: any, signal: any) => Promise<any>,
  resume?: (ctx: any, agent: any, attempt: any, signal: any) => Promise<any>,
) =>
  (ctx: any, agent: any, attempt: any, signal: any) =>
    attempt.kind === "resume" ? (resume ?? spawn)(ctx, agent, attempt, signal) : spawn(ctx, agent, attempt, signal);
