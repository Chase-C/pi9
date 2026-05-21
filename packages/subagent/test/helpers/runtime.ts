import { AgentManager, type AgentRunner } from "../../src/runtime/agent-manager.js";

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
