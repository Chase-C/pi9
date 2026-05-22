import { randomUUID } from "node:crypto";

import { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import type { AgentRunResult } from "../domain/agent-result.js";
import type { AgentRunStatus, AgentUpdateKind, AgentView } from "../domain/agent-view.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import type { SessionStatus, TaskRequest } from "../schema.js";
import { projectAgentView } from "../view/project-agent-view.js";
import { activeOrRetainedAgents, effectiveStatus } from "../view/view-helpers.js";
import { AttemptRunner, type AgentRunner } from "./attempt-runner.js";
import { resolveResume, resolveSpawn } from "./preflight.js";
import { RunGroup, type RunUpdateListener } from "./run-group.js";
import { timingMark, timingStart } from "./timing.js";

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;
export type { AgentRunner } from "./attempt-runner.js";
export type { RunUpdate, RunUpdateListener } from "./run-group.js";

export type BackgroundResult =
  | { sessionId: string; ready: true; result: AgentRunResult }
  | { sessionId: string; ready: false; status: "queued" | "running"; elapsedMs: number; agent: string; label?: string }
  | { sessionId: string; error: string };

export interface StartRunOptions {
  background: boolean;
  parentSessionId?: string;
}

export interface RunHandle {
  readonly groupId: string;
  /** Root sessions in input order, captured at handle creation. */
  readonly sessions: AgentView[];
  /** Live snapshot of the run tree (roots + descendants in pre-order). */
  tree(): AgentView[];
  readonly resultsPromise: Promise<AgentRunResult[]>;
}

export class AgentManager {

  private _agents = new Array<Agent>();
  private _updateListeners = new Set<AgentUpdateListener>();
  private readonly _runner: AttemptRunner;
  private readonly _groups = new Map<string, RunGroup>();
  /** In-flight cancellation fanouts keyed by the finalized parent's session id. */
  private readonly _pendingFinalize = new Map<string, Promise<void>>();

  constructor(
    readonly registry: AgentRegistry,
    maxRunning: number = 4,
    runner?: AgentRunner,
  ) {
    this._runner = new AttemptRunner({
      maxRunning,
      ...(runner ? { runner } : {}),
      isTracked: id => this._agents.some(a => a.id === id),
    });
  }

  listSessions(filter?: { status?: SessionStatus[] }): AgentView[] {
    const views = activeOrRetainedAgents(this._agents).map(agent => projectAgentView(agent));
    if (!filter || filter.status === undefined) return views;
    const allowed = new Set(filter.status);
    return views.filter(view => allowed.has(effectiveStatus(view.status) as SessionStatus));
  }

  configure(options: { maxRunning?: number }) {
    this._runner.configure(options);
  }

  get runner(): AttemptRunner { return this._runner; }

  /** Adds a freshly-spawned agent to the catalog and subscribes the catalog's broadcast pipeline. */
  adopt(agent: Agent): void {
    this._agents.push(agent);
    agent.on(this._agentUpdate.bind(this));
  }

  /** Looks up an existing agent eligible for resume by sessionId. */
  findResumable(id: string): Agent | undefined {
    return this._agents.find(a => a.id === id && a.resumable);
  }

  onAgentUpdate(listener: AgentUpdateListener): () => void {
    this._updateListeners.add(listener);
    return () => this._updateListeners.delete(listener);
  }

  /**
   * Releases the named agent's queue slot while `fn` runs, then re-acquires it before returning.
   * Used by the child subagent tool so a parent awaiting `handle.resultsPromise` doesn't pin the
   * only queue slot a recursive descendant needs to start — without this, a tree deeper than
   * maxRunning deadlocks. No-op when the session has no active lease.
   */
  async suspendAgentSlotDuring<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this._runner.suspendAgentSlotDuring(sessionId, fn);
  }

  /**
   * Walks the descendant subtree of `parentSessionId` post-order (grandchildren before children)
   * and awaits `abort()` on each. `Array.filter` snapshots the descendants before iterating so
   * concurrent `remove()` / `startRun()` mutations of `_agents` don't disturb the walk.
   * `Agent.abort()` is a no-op for already-terminal agents, so re-calling it is safe.
   */
  async abortDescendantsOf(parentSessionId: string): Promise<void> {
    const directChildren = this._agents.filter(a => a.parentSessionId === parentSessionId);
    timingMark("manager.abortDescendants.walk", { parentSessionId, directChildCount: directChildren.length });
    for (const child of directChildren) {
      timingMark("manager.abortDescendants.child", { parentSessionId, childId: child.id, agent: child.agentName, statusKind: child.status.kind, background: child.background });
      await this.abortDescendantsOf(child.id);
      await child.abort();
    }
  }

  /**
   * Same post-order walk as `abortDescendantsOf` but skips agents currently flagged
   * `background === true`. The check uses the live flag, so an agent promoted via
   * `promoteToBackground` between spawn and finalize is treated as background.
   */
  async cancelNonBackgroundDescendantsOf(parentSessionId: string, reason: string): Promise<void> {
    const directChildren = this._agents.filter(a => a.parentSessionId === parentSessionId);
    timingMark("manager.cancelNonBackgroundDescendants.walk", { parentSessionId, directChildCount: directChildren.length, reason });
    for (const child of directChildren) {
      if (child.background) {
        timingMark("manager.cancelNonBackgroundDescendants.skipBackground", { parentSessionId, childId: child.id, agent: child.agentName });
        continue;
      }
      timingMark("manager.cancelNonBackgroundDescendants.child", { parentSessionId, childId: child.id, agent: child.agentName, statusKind: child.status.kind });
      await this.cancelNonBackgroundDescendantsOf(child.id, reason);
      await child.abort(reason);
    }
  }

  async backgroundResults(
    sessionIds: string[],
    options: { remove?: boolean } = {},
  ): Promise<BackgroundResult[]> {
    const remove = options.remove === true;
    const results: BackgroundResult[] = [];
    const terminalIds = new Set<string>();
    for (const id of sessionIds) {
      const agent = this._agents.find(a => a.id === id);
      if (!agent) {
        results.push({ sessionId: id, error: `Unknown subagent session: ${id}` });
        continue;
      }
      const status = agent.status;
      if (status.kind === "done") {
        results.push({ sessionId: id, ready: true, result: status.result });
        if (remove) terminalIds.add(id);
        continue;
      }
      const now = Date.now();
      const elapsedMs = status.kind === "running"
        ? now - status.startedAt
        : now - status.queuedAt;
      const entry: Extract<BackgroundResult, { ready: false }> = {
        sessionId: id,
        ready: false,
        status: status.kind === "running" ? "running" : "queued",
        elapsedMs,
        agent: agent.agentName,
      };
      if (agent.label !== undefined) entry.label = agent.label;
      results.push(entry);
    }
    if (terminalIds.size > 0) await this.remove({ sessionIds: Array.from(terminalIds) });
    return results;
  }

  async remove(
    args: { sessionIds: string[] } | { scope: "background" | "retained" | "non-running" },
  ): Promise<{ removed: number; aborted: number; sessionIds: string[]; errors: Array<{ sessionId: string; error: string }> }> {
    const errors: Array<{ sessionId: string; error: string }> = [];
    const targets: Agent[] = [];

    if ("sessionIds" in args) {
      for (const id of args.sessionIds) {
        const agent = this._agents.find(a => a.id === id);
        if (!agent) errors.push({ sessionId: id, error: `Unknown subagent session: ${id}` });
        else targets.push(agent);
      }
    } else {
      targets.push(...this._matchScope(args.scope));
    }

    let aborted = 0;
    const fanouts: Promise<void>[] = [];
    for (const agent of targets) {
      const status = agent.status.kind;
      if (status === "running" || status === "queued") {
        await agent.abort();
        if (status === "running") aborted += 1;
        const pending = this._pendingFinalize.get(agent.id);
        if (pending) fanouts.push(pending);
      }
    }
    if (fanouts.length > 0) await Promise.all(fanouts);

    const removedIds = new Set(targets.map(a => a.id));
    if (removedIds.size > 0) {
      this._agents = this._agents.filter(a => !removedIds.has(a.id));
      // Tell every live group that one of its tree members vanished so it can re-emit.
      for (const group of this._groups.values()) {
        if (Array.from(removedIds).some(id => group.contains(id))) group.emit();
      }
    }

    return {
      removed: removedIds.size,
      aborted,
      sessionIds: Array.from(removedIds),
      errors,
    };
  }

  /** Convenience: start a foreground run and wait for results. */
  async run(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    tasks: TaskRequest[],
    onUpdate?: RunUpdateListener,
    options: { parentSessionId?: string } = {},
  ): Promise<AgentRunResult[]> {
    const handle = this.startRun(ctx, signal, tasks, onUpdate, { background: false, ...options });
    return handle.resultsPromise;
  }

  /**
   * Starts a run group. Each task is resolved through pure preflight helpers; surviving spawns
   * adopt a new Agent into the catalog, surviving resumes start a fresh attempt on the existing
   * Agent. Every agent in the group is wired into a {@link RunGroup} so updates from
   * {@link onAgentUpdate} route back to its listener.
   */
  startRun(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    tasks: TaskRequest[],
    onUpdate: RunUpdateListener | undefined,
    options: StartRunOptions,
  ): RunHandle {
    const groupId = randomUUID();
    const groupCreatedAt = Date.now();
    timingMark("manager.run.start", { groupId, taskCount: tasks.length, background: options.background, parentSessionId: options.parentSessionId });

    const controller = options.background ? new AbortController() : undefined;
    const group = new RunGroup({
      groupId,
      ...(onUpdate ? { listener: onUpdate } : {}),
      walkTree: rootIds => this._walkTree(rootIds),
    });
    this._groups.set(groupId, group);

    const childSignal = controller ? controller.signal : signal;
    const touched = new Set<string>();

    const resultPromises = tasks.map((task, inputIndex) => {
      if (task.kind === "spawn") {
        const preflight = resolveSpawn({ task, groupId, inputIndex, createdAt: groupCreatedAt, registry: this.registry, background: options.background });
        if (preflight.kind === "failure") {
          group.addStaticView(preflight.failure.view, inputIndex, false);
          timingMark("manager.task.preflightFailure", { groupId, inputIndex, agent: task.agent, parentSessionId: options.parentSessionId });
          return Promise.resolve(preflight.failure.result);
        }

        const agent = new Agent(randomUUID(), preflight.config, task, {
          background: options.background,
          ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
        });
        this.adopt(agent);
        group.addAgent(agent, inputIndex, false);
        timingMark("manager.task.spawnCreated", { groupId, inputIndex, agent: task.agent, sessionId: agent.id, parentSessionId: options.parentSessionId, background: options.background });
        touched.add(agent.id);
        return this._runner.run(ctx, childSignal, agent, agent.requireCurrentAttempt());
      }

      const preflight = resolveResume({
        task, groupId, inputIndex, createdAt: groupCreatedAt,
        findResumable: id => this.findResumable(id),
        background: options.background,
      });
      if (preflight.kind === "failure") {
        group.addStaticView(preflight.failure.view, inputIndex, true);
        timingMark("manager.task.resumePreflightFailure", { groupId, inputIndex, sessionId: task.sessionId, parentSessionId: options.parentSessionId });
        return Promise.resolve(preflight.failure.result);
      }

      const target = preflight.target;
      const attempt = target.startResume(task);
      if (options.background) target.promoteToBackground();
      group.addAgent(target, inputIndex, true);
      timingMark("manager.task.resumeCreated", { groupId, inputIndex, sessionId: target.id, parentSessionId: options.parentSessionId, targetParentSessionId: target.parentSessionId, background: options.background });
      touched.add(target.id);
      return this._runner.run(ctx, childSignal, target, attempt);
    });

    timingMark("manager.initialEmit.before", { groupId, entries: group.entryCount });
    group.emit();
    timingMark("manager.initialEmit.after", { groupId });

    // Capture the initial root sessions so the handle.sessions field is stable.
    const initialSessions = group.rootSessions();

    const resultsPromise = Promise.all(resultPromises)
      .then(results => {
        this._pruneTouched(touched);
        timingMark("manager.run.results", { groupId, resultCount: results.length });
        return results;
      })
      .finally(() => {
        group.flush();
        group.dispose();
        this._groups.delete(groupId);
      });

    return {
      groupId,
      sessions: initialSessions,
      tree: () => group.tree(),
      resultsPromise,
    };
  }

  /**
   * Post-run pruning. Drops agents in `touched` that are done, non-background, and non-resumable.
   * Survivors stay in the catalog.
   */
  private _pruneTouched(touched: ReadonlySet<string>): void {
    this._agents = this._agents.filter(agent => {
      if (!touched.has(agent.id)) return true;
      if (agent.background) return true;
      if (agent.status.kind !== "done") return true;
      if (agent.resumable) return true;
      return false;
    });
  }

  private _matchScope(scope: "background" | "retained" | "non-running"): Agent[] {
    if (scope === "background") return this._agents.filter(a => a.background);
    if (scope === "retained") return this._agents.filter(a => !a.background && a.status.kind !== "running" && a.resumable);
    if (scope === "non-running") return this._agents.filter(a => a.status.kind !== "running");
    throw new Error(`Unknown remove scope: ${String(scope)}`);
  }

  /**
   * Returns the union of the named roots and every descendant reachable through `parentSessionId`,
   * as `AgentView`s. Roots appear in input order; descendants under each parent are sorted by
   * `createdAt` ascending. Used by RunGroup to project the live subtree. Missing root ids are
   * silently skipped.
   */
  private _walkTree(rootIds: string[]): AgentView[] {
    const byId = new Map<string, Agent>();
    for (const agent of this._agents) byId.set(agent.id, agent);

    const out: AgentView[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      const agent = byId.get(id);
      if (!agent) return;
      seen.add(id);
      out.push(projectAgentView(agent));
      const children = this._agents.filter(a => a.parentSessionId === id);
      children.sort((a, b) => a.createdAt - b.createdAt);
      for (const child of children) visit(child.id);
    };
    for (const id of rootIds) visit(id);
    return out;
  }

  private _agentUpdate(agent: Agent, kind: AgentUpdateKind) {
    const status = agent.status;
    timingMark("manager.agentUpdate", {
      sessionId: agent.id,
      agent: agent.agentName,
      parentSessionId: agent.parentSessionId,
      kind,
      statusKind: status.kind,
      ...(status.kind === "done" ? { outcome: status.result.status } : {}),
      background: agent.background,
    });
    for (const listener of this._updateListeners) listener(agent, kind);
    for (const group of this._groups.values()) group.handleAgentUpdate(agent.id, kind);
    if (kind === "status") this._maybeFinalizeFanout(agent);
  }

  /**
   * Internal parent-finalize policy: when an agent finalizes as `aborted` or `error`, cancel
   * its still-running non-background descendants. `completed` and other outcomes leave
   * descendants alone — a completed parent has already consumed children's results, and any
   * survivors must be background ones the parent dispatched to outlive itself.
   */
  private _maybeFinalizeFanout(agent: Agent): void {
    if (this._pendingFinalize.has(agent.id)) return;
    const outcome = this._terminalOutcome(agent);
    if (outcome !== "aborted" && outcome !== "error") return;

    const reason = `Parent ${agent.id} finalized as ${outcome}`;
    const fanoutEnd = timingStart("manager.parentFinalize.fanout", { sessionId: agent.id, agent: agent.agentName, outcome });
    const promise = this
      .cancelNonBackgroundDescendantsOf(agent.id, reason)
      .finally(() => {
        this._pendingFinalize.delete(agent.id);
        fanoutEnd({});
      });
    this._pendingFinalize.set(agent.id, promise);
  }

  private _terminalOutcome(agent: Agent): AgentRunStatus | undefined {
    const status = agent.status;
    return status.kind === "done" ? status.result.status : undefined;
  }
}
