import { randomUUID } from "node:crypto";

import { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import type { AgentRunResult } from "../domain/agent-result.js";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentView } from "../domain/agent-view.js";
import type { TaskRequest } from "../schema.js";
import type { AgentManager } from "./agent-manager.js";
import { BatchRun, type BatchUpdateListener } from "./batch-run.js";
import { resolveResume, resolveSpawn } from "./preflight.js";
import { timingMark } from "./timing.js";

export interface BatchOrchestratorDependencies {
  manager: AgentManager;
  registry: AgentRegistry;
}

export interface StartBatchOptions {
  background: boolean;
  parentSessionId?: string;
}

export interface BatchHandle {
  groupId: string;
  readonly sessions: AgentView[];
  resultsPromise: Promise<AgentRunResult[]>;
}

/**
 * Orchestrates a batch of spawn/resume tasks. Each task is resolved through pure preflight
 * helpers; surviving spawns adopt a new Agent into the catalog, surviving resumes start a
 * fresh attempt on the existing Agent. Every agent in the batch is registered with the
 * BatchSet so updates from `manager.onAgentUpdate` route back to this batch's BatchRun.
 */
export class BatchOrchestrator {

  constructor(private readonly deps: BatchOrchestratorDependencies) {}

  async run(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    tasks: TaskRequest[],
    onUpdate?: BatchUpdateListener,
    options: { parentSessionId?: string } = {},
  ): Promise<AgentRunResult[]> {
    const batch = this.startBatch(ctx, signal, tasks, onUpdate, { background: false, ...options });
    return batch.resultsPromise;
  }

  startBatch(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    tasks: TaskRequest[],
    onUpdate: BatchUpdateListener | undefined,
    options: StartBatchOptions,
  ): BatchHandle {
    const { manager, registry } = this.deps;
    const groupId = randomUUID();
    const groupCreatedAt = Date.now();
    timingMark("manager.run.start", { groupId, taskCount: tasks.length, background: options.background, parentSessionId: options.parentSessionId });

    const controller = options.background ? new AbortController() : undefined;
    const batch = new BatchRun(groupId, onUpdate);
    manager.batches.register(groupId, batch);

    const childSignal = controller ? controller.signal : signal;
    const touched = new Set<string>();

    const resultPromises = tasks.map((task, inputIndex) => {
      if (task.kind === "spawn") {
        const preflight = resolveSpawn({ task, groupId, inputIndex, createdAt: groupCreatedAt, registry, background: options.background });
        if (preflight.kind === "failure") {
          batch.addStaticView(preflight.failure.view, inputIndex, false);
          timingMark("manager.task.preflightFailure", { groupId, inputIndex, agent: task.agent, parentSessionId: options.parentSessionId });
          return Promise.resolve(preflight.failure.result);
        }

        const agent = new Agent(randomUUID(), preflight.config, task, {
          background: options.background,
          ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
        });
        manager.adopt(agent);
        batch.addAgent(agent, inputIndex, false);
        timingMark("manager.task.spawnCreated", { groupId, inputIndex, agent: task.agent, sessionId: agent.id, parentSessionId: options.parentSessionId, background: options.background });
        manager.batches.attach(agent.id, groupId);
        touched.add(agent.id);
        return manager.runner.run(ctx, childSignal, agent, agent.requireCurrentAttempt());
      }

      const preflight = resolveResume({
        task, groupId, inputIndex, createdAt: groupCreatedAt,
        findResumable: id => manager.findResumable(id),
        background: options.background,
      });
      if (preflight.kind === "failure") {
        batch.addStaticView(preflight.failure.view, inputIndex, true);
        timingMark("manager.task.resumePreflightFailure", { groupId, inputIndex, sessionId: task.sessionId, parentSessionId: options.parentSessionId });
        return Promise.resolve(preflight.failure.result);
      }

      const target = preflight.target;
      const attempt = target.startResume(task);
      if (options.background) target.promoteToBackground();
      batch.addAgent(target, inputIndex, true);
      timingMark("manager.task.resumeCreated", { groupId, inputIndex, sessionId: target.id, parentSessionId: options.parentSessionId, targetParentSessionId: target.parentSessionId, background: options.background });
      manager.batches.attach(target.id, groupId);
      touched.add(target.id);
      return manager.runner.run(ctx, childSignal, target, attempt);
    });

    timingMark("manager.initialEmit.before", { groupId, entries: batch.entryCount });
    batch.emit();
    timingMark("manager.initialEmit.after", { groupId });

    const resultsPromise = Promise.all(resultPromises)
      .then(results => {
        manager.pruneTouched(touched);
        timingMark("manager.run.results", { groupId, resultCount: results.length });
        return results;
      })
      .finally(() => {
        manager.batches.dispose(groupId);
      });

    return {
      groupId,
      get sessions(): AgentView[] { return batch.sessions(); },
      resultsPromise,
    };
  }
}
