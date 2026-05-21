import { AgentManager, type AgentRunner } from "../../src/runtime/agent-manager.js";
import { BatchOrchestrator } from "../../src/runtime/batch-orchestrator.js";
import { ParentFinalizePolicy } from "../../src/runtime/parent-finalize-policy.js";

/**
 * Builds a real AgentManager + BatchOrchestrator pair with the ParentFinalizePolicy
 * subscription wired up. Mirrors what `subagentExtension` builds in production so
 * tests that exercise the full lifecycle (spawn → finalize → cascade) behave the
 * same way as the runtime.
 */
export function makeManagerAndOrchestrator(
  registry: any,
  maxRunning: number = 4,
  runner?: AgentRunner,
): { manager: AgentManager; orchestrator: BatchOrchestrator } {
  const manager = new AgentManager(registry, maxRunning, runner);
  const orchestrator = new BatchOrchestrator({ manager, registry });
  // The policy registers itself via manager.onAgentUpdate; the subscription closure
  // keeps the instance alive for the lifetime of the manager.
  new ParentFinalizePolicy({ manager });
  return { manager, orchestrator };
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
