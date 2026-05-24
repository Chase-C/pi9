import { randomUUID } from "node:crypto";

import { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Agent, type AgentUpdateKind } from "../domain/agent.js";
import { toResultJson, type BackgroundResult } from "../domain/agent-result.js";
import { activeOrRetainedAgents, effectiveStatus } from "../domain/agent-decisions.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import type { SessionStatus, TaskRequest } from "../schema.js";
import { AttemptRunner, type AgentRunner } from "./attempt-runner.js";
import { RunGroup, type RunUpdateListener } from "./run-group.js";
import { timingStart } from "./timing.js";

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;
export type { AgentRunner } from "./attempt-runner.js";
export type { RunUpdate, RunUpdateListener } from "./run-group.js";
export type { BackgroundResult } from "../domain/agent-result.js";

export interface StartRunOptions {
  background: boolean;
  parentId?: string;
}

export interface RunHandle {
  readonly groupId: string;
  /** Root sessions in input order, captured at handle creation. */
  readonly sessions: AgentSnapshot[];
  /** Live snapshot of the run tree (roots + descendants in pre-order). */
  tree(): AgentSnapshot[];
  /** Terminal snapshots in input order. The tool layer projects each via `toResultJson`. */
  readonly resultsPromise: Promise<AgentSnapshot[]>;
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

  listSessions(filter?: { status?: SessionStatus[] }): AgentSnapshot[] {
    const views = activeOrRetainedAgents(this._agents).map(agent => agent.snapshot());
    if (!filter || filter.status === undefined) return views;
    const allowed = new Set(filter.status);
    return views.filter(view => allowed.has(effectiveStatus(view.status) as SessionStatus));
  }

  configure(options: { maxRunning?: number }) {
    this._runner.configure(options);
  }

  get runner(): AttemptRunner { return this._runner; }

  onAgentUpdate(listener: AgentUpdateListener): () => void {
    this._updateListeners.add(listener);
    return () => this._updateListeners.delete(listener);
  }

  /**
   * Post-order walk of the descendant subtree of `parentSessionId` (grandchildren before
   * children) that awaits `abort()` on each visited agent. `Array.filter` snapshots the
   * descendants before iterating so concurrent `remove()` / `startRun()` mutations of `_agents`
   * don't disturb the walk. `Agent.abort()` is a no-op for already-terminal agents.
   *
   * `skipBackground: true` skips background descendants entirely — their subtrees are not
   * recursed into either, since the policy of letting background work outlive its parent
   * extends to that work's own children.
   */
  async cancelDescendantsOf(
    parentSessionId: string,
    options: { skipBackground?: boolean; reason?: string } = {},
  ): Promise<void> {
    const { skipBackground = false, reason } = options;
    const toCancel = this._agents
      .filter(a => a.parentId === parentSessionId)
      .filter(a => !(skipBackground && a.background));

    for (const child of toCancel) {
      await this.cancelDescendantsOf(child.id, options);
      await child.abort(reason);
    }
  }

  backgroundResults(
    sessionIds: string[],
  ): BackgroundResult[] {
    return sessionIds.map(id => {
      const lookup = this._resolveSession(id);
      if ("error" in lookup) return lookup;

      const agent = lookup.agent;
      const status = agent.status;
      if (status.kind === "done") {
        return { sessionId: id, ready: true, result: toResultJson(agent.snapshot()) };
      }

      const beginAt = (status.kind === "running") ? status.startedAt : status.queuedAt;
      return {
        sessionId: id,
        ready: false,
        status: status.kind,
        elapsedMs: Date.now() - beginAt,
        agent: agent.agentName,
        ...(agent.label ? { label: agent.label } : {}),
      };
    });
  }

  async remove(
    args: { sessionIds: string[] } | { scope: "background" | "retained" | "non-running" },
  ): Promise<{ removed: number; aborted: number; sessionIds: string[]; errors: Array<{ sessionId: string; error: string }> }> {
    const targets = ("sessionIds" in args)
      ? args.sessionIds.map(id => this._resolveSession(id))
      : this._matchScope(args.scope).map(agent => ({ agent }));

    const agents = targets.filter(t => "agent" in t).map(({ agent }) => agent);
    const errors = targets.filter(t => "error" in t);

    const uniqueRunning = new Set(agents.filter(a => a.status.kind === "running").map(a => a.id));
    const aborted = uniqueRunning.size;

    await Promise.all(agents.map(async agent => {
      await agent.abort();
      await this._pendingFinalize.get(agent.id);
    }));

    const removedIds = new Set(agents.map(a => a.id));
    this._agents = this._agents.filter(a => !removedIds.has(a.id));
    for (const group of this._groups.values()) {
      if (agents.some(a => group.contains(a.id))) group.emit();
    }

    return {
      removed: removedIds.size,
      aborted,
      sessionIds: Array.from(removedIds),
      errors,
    };
  }

  /**
   * Starts a run group. Each task is resolved through pure preflight helpers; surviving spawns
   * adopt a new Agent into the catalog, surviving resumes start a fresh attempt on the existing
   * Agent. Every agent in the group is wired into a {@link RunGroup} so updates from
   * {@link onAgentUpdate} route back to its listener.
   *
   * Foreground callers can await `handle.resultsPromise` directly.
   */
  startRun(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    tasks: TaskRequest[],
    onUpdate: RunUpdateListener | undefined,
    options: StartRunOptions,
  ): RunHandle {
    const groupId = randomUUID();
    const createdAt = Date.now();

    const group = new RunGroup({ groupId, onUpdate, walkTree: ids => this._walkTree(ids) });
    this._groups.set(groupId, group);

    const controller = options.background ? new AbortController() : undefined;
    const childSignal = controller ? controller.signal : signal;
    const touched = new Set<string>();

    const { background, parentId } = options;
    const results = tasks.map((task, inputIndex) => {
      const resumed = task.kind === "resume";
      const result = Agent.resolve({
        task, background, groupId, inputIndex, createdAt, parentId, registry: this.registry,
        findAgent: id => this._agents.find(a => a.id === id),
        listener: (agent, update) => this._agentUpdate(agent, update),
      });

      if (result.kind === "failure") {
        group.addStaticView(result.failure, inputIndex, resumed);
        return Promise.resolve(result.failure);
      }

      if (result.kind === "spawn") {
        this._agents.push(result.agent);
      }

      group.addAgent(result.agent, inputIndex, resumed);
      touched.add(result.agent.id);
      return this._runner.run(ctx, childSignal, result.agent, result.agent.requireCurrentAttempt());
    });

    group.emit();

    // Capture the initial root sessions so the handle.sessions field is stable.
    const initialSessions = group.rootSessions();
    const resultsPromise = Promise.all(results)
      .finally(() => {
        this._agents = this._agents.filter(
          agent => !touched.has(agent.id)
            || agent.background
            || agent.status.kind !== "done"
            || agent.resumable
        );

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

  /** Looks up an agent by sessionId or returns the standard not-found error entry. */
  private _resolveSession(id: string): { agent: Agent } | { sessionId: string; error: string } {
    const agent = this._agents.find(a => a.id === id);
    if (agent) return { agent };
    return { sessionId: id, error: `Unknown subagent session: ${id}` };
  }

  private _matchScope(scope: "background" | "retained" | "non-running"): Agent[] {
    if (scope === "background") return this._agents.filter(a => a.background);
    if (scope === "retained") return this._agents.filter(a => !a.background && a.status.kind !== "running" && a.resumable);
    if (scope === "non-running") return this._agents.filter(a => a.status.kind !== "running");
    throw new Error(`Unknown remove scope: ${String(scope)}`);
  }

  /**
   * Returns the union of the named roots and every descendant reachable through `parentSessionId`,
   * as `AgentSnapshot`s. Roots appear in input order; descendants under each parent are sorted by
   * `createdAt` ascending. Used by RunGroup to project the live subtree. Missing root ids are
   * silently skipped.
   */
  private _walkTree(rootIds: string[]): AgentSnapshot[] {
    const out: AgentSnapshot[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      const agent = this._agents.find(a => a.id === id);
      if (!agent) return;
      seen.add(id);
      out.push(agent.snapshot());
      const children = this._agents.filter(a => a.parentId === id);
      children.sort((a, b) => a.createdAt - b.createdAt);
      for (const child of children) visit(child.id);
    };
    for (const id of rootIds) visit(id);
    return out;
  }

  private _agentUpdate(agent: Agent, kind: AgentUpdateKind) {
    const status = agent.status;

    for (const listener of this._updateListeners) listener(agent, kind);
    for (const group of this._groups.values()) group.handleAgentUpdate(agent.id, kind);

    if (kind !== "status") return;
    if (this._pendingFinalize.has(agent.id)) return;

    const outcome = status.kind === "done" ? status.result.status : undefined;
    if (outcome !== "aborted" && outcome !== "error") return;

    const reason = `Parent ${agent.id} finalized as ${outcome}`;
    const fanoutEnd = timingStart("manager.parentFinalize.fanout", { sessionId: agent.id, agent: agent.agentName, outcome });
    const promise = this
      .cancelDescendantsOf(agent.id, { skipBackground: true, reason })
      .finally(() => {
        this._pendingFinalize.delete(agent.id);
        fanoutEnd({});
      });
    this._pendingFinalize.set(agent.id, promise);
  }
}
