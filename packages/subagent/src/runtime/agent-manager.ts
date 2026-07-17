import { randomUUID } from "node:crypto";

import { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import type { AgentDispatch, AgentUpdateKind } from "../domain/agent-lifecycle.js";
import type { ResultEntry } from "../domain/agent-result.js";
import { effectiveStatus } from "../domain/agent-decisions.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import type { SessionStatus, TaskRequest } from "../schema.js";
import { AttemptRunner, type AgentRunner } from "./attempt-runner.js";
import { RunGroup, type RunUpdateListener } from "./run-group.js";
import { SessionIdAllocator } from "./session-id-allocator.js";
import { resolveTask } from "./task-resolution.js";
import { timingStart } from "./timing.js";

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;
export type { AgentRunner } from "./attempt-runner.js";
export type { RunUpdate, RunUpdateListener } from "./run-group.js";
export type { ResultEntry } from "../domain/agent-result.js";

export interface StartRunOptions {
  dispatch: AgentDispatch;
  parentId?: string;
}

export interface SessionConversationMessage {
  readonly role: "user" | "assistant" | "tool" | "toolResult";
  readonly text: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

export interface SessionConversationDetail {
  readonly session: AgentSnapshot;
  readonly messages: readonly SessionConversationMessage[];
  readonly pending: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
}

export interface RunHandle {
  /** Root sessions in input order, captured at handle creation. */
  readonly sessions: AgentSnapshot[];
  /** Terminal snapshots in input order. The tool layer projects each via `toResult`. */
  readonly resultsPromise: Promise<AgentSnapshot[]>;
}

export class AgentManager {

  private _agents = new Array<Agent>();
  private _updateListeners = new Set<AgentUpdateListener>();
  private readonly _runner: AttemptRunner;
  private readonly _sessionIdAllocator = new SessionIdAllocator();
  private readonly _groups = new Map<string, RunGroup>();
  private readonly _removingSessionIds = new Set<string>();
  private readonly _acknowledgedResultIds = new Set<string>();
  private readonly _descendantsByAncestor = new Map<string, Map<string, AgentSnapshot>>();
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
    const listed = this._agents
      .filter(agent => !this._removingSessionIds.has(agent.id))
      .filter(agent => agent.retentionDecision.cataloged);
    const views = listed.map(agent => agent.snapshot());
    if (!filter || filter.status === undefined) return views;
    const allowed = new Set(filter.status);
    return views.filter(view => allowed.has(effectiveStatus(view.status) as SessionStatus));
  }

  sessionConversation(sessionId: string): SessionConversationDetail {
    const lookup = this._resolveSession(sessionId);
    if ("error" in lookup) throw new Error(lookup.error);
    return this._conversationDetail(lookup.agent);
  }

  async stopSession(sessionId: string): Promise<void> {
    const lookup = this._resolveSession(sessionId);
    if ("error" in lookup) throw new Error(lookup.error);
    await lookup.agent.abort("Stopped by user.");
  }

  async steerSession(sessionId: string, text: string): Promise<void> {
    const lookup = this._resolveSession(sessionId);
    if ("error" in lookup) throw new Error(lookup.error);
    if (lookup.agent.status.kind !== "running") {
      throw new Error(`Cannot steer subagent session ${sessionId} while it is not running.`);
    }
    const session = lookup.agent.retainedSession();
    if (!session) throw new Error(`Subagent session ${sessionId} has not started.`);
    await session.steer(text);
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
      .filter(a => !(skipBackground && a.snapshot().attempt.dispatch === "background"));

    for (const child of toCancel) {
      await this.cancelDescendantsOf(child.id, options);
      await child.abort(reason);
    }
  }

  /**
   * One render entry per requested id, in input order: the agent's current snapshot (terminal or
   * pending), or an error for an unknown id. The tool layer projects these into the model-facing
   * `results` JSON via `toResults`.
   */
  backgroundResults(sessionIds: string[]): ResultEntry[] {
    return sessionIds.map(id => {
      const lookup = this._resolveSession(id);
      if ("error" in lookup) return lookup;
      const snapshot = this.snapshotWithSubagents(lookup.agent.snapshot());
      if (snapshot.status.kind === "done") this._acknowledgedResultIds.add(id);
      return { snapshot };
    });
  }

  isResultAcknowledged(sessionId: string): boolean {
    return this._acknowledgedResultIds.has(sessionId);
  }

  async remove(
    args: { sessionIds: string[] },
  ): Promise<{ removed: number; aborted: number; sessionIds: string[]; errors: Array<{ sessionId: string; error: string }> }> {
    const targets = args.sessionIds.map(id => this._resolveSession(id));

    const agents = targets.filter(t => "agent" in t).map(({ agent }) => agent);
    const errors = targets.filter(t => "error" in t);

    const uniqueRunning = new Set(agents.filter(a => a.status.kind === "running").map(a => a.id));
    const aborted = uniqueRunning.size;
    for (const agent of agents) this._removingSessionIds.add(agent.id);

    try {
      await Promise.all(agents.map(async agent => {
        await agent.abort();
        await this._pendingFinalize.get(agent.id);
      }));

      const removedIds = new Set(agents.map(a => a.id));
      this._agents = this._agents.filter(a => !removedIds.has(a.id));
      for (const id of removedIds) {
        this._acknowledgedResultIds.delete(id);
        this._descendantsByAncestor.delete(id);
      }
      for (const descendants of this._descendantsByAncestor.values()) {
        for (const id of removedIds) descendants.delete(id);
      }
      for (const group of this._groups.values()) {
        if (agents.some(a => group.contains(a.id))) group.emit();
      }

      return {
        removed: removedIds.size,
        aborted,
        sessionIds: Array.from(removedIds),
        errors,
      };
    } finally {
      for (const agent of agents) this._removingSessionIds.delete(agent.id);
    }
  }

  /**
   * Starts a run group. Each task is resolved by the runtime task resolver; surviving spawns
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

    const group = new RunGroup({ groupId, onUpdate, walkTree: ids => this._walkTree(ids) });
    this._groups.set(groupId, group);

    // Background runs deliberately decouple from the caller's cancellation signal.
    const childSignal = options.dispatch === "background" ? undefined : signal;
    const touched = new Set<string>();

    const { dispatch, parentId } = options;
    const results = tasks.map((task, inputIndex) => {
      const result = resolveTask({
        task, dispatch, groupId, inputIndex, parentId, registry: this.registry,
        findAgent: id => this._agents.find(a => a.id === id),
        allocateSessionId: () => this._sessionIdAllocator.allocate(),
        listener: (agent, update) => this._agentUpdate(agent, update),
      });

      if (result.kind === "failure") {
        group.addStaticView(result.failure, inputIndex);
        return Promise.resolve(result.failure);
      }

      if (result.kind === "spawn") {
        this._agents.push(result.agent);
      } else {
        this._acknowledgedResultIds.delete(result.agent.id);
      }

      group.addAgent(result.agent, inputIndex);
      this._descendantsByAncestor.delete(result.agent.id);
      touched.add(result.agent.id);
      return this._runner.run(ctx, childSignal, result.agent, result.agent.requireCurrentAttempt());
    });

    group.emit();

    // Capture the initial root sessions so the handle.sessions field is stable.
    const initialSessions = group.rootSessions();
    const resultsPromise = Promise.all(results)
      .finally(() => {
        this._agents = this._agents.filter(
          agent => !touched.has(agent.id) || agent.retentionDecision.cataloged
        );

        group.flush();
        group.dispose();
        this._groups.delete(groupId);
      });

    return {
      sessions: initialSessions,
      resultsPromise,
    };
  }

  snapshotWithSubagents(snapshot: AgentSnapshot): AgentSnapshot {
    const descendants = this._descendantsByAncestor.get(snapshot.id);
    if (!descendants?.size) return snapshot;
    const childrenByParent = new Map<string, AgentSnapshot[]>();
    for (const descendant of descendants.values()) {
      const parentId = descendant.parentSessionId ?? snapshot.id;
      const children = childrenByParent.get(parentId) ?? [];
      children.push(descendant);
      childrenByParent.set(parentId, children);
    }
    for (const children of childrenByParent.values()) children.sort((a, b) => a.createdAt - b.createdAt);
    const subagents: AgentSnapshot[] = [];
    const visit = (parentId: string) => {
      for (const child of childrenByParent.get(parentId) ?? []) {
        subagents.push(child);
        visit(child.id);
      }
    };
    visit(snapshot.id);
    if (!this._agents.some(agent => agent.id === snapshot.id)) this._descendantsByAncestor.delete(snapshot.id);
    return { ...snapshot, subagents };
  }

  private _conversationDetail(agent: Agent): SessionConversationDetail {
    const runtime = agent.retainedSession();
    return {
      session: agent.snapshot(),
      messages: projectConversationMessages((runtime?.messages ?? []).slice(-60)),
      pending: {
        steering: runtime?.getSteeringMessages?.() ?? [],
        followUp: runtime?.getFollowUpMessages?.() ?? [],
      },
    };
  }

  /** Looks up an agent by sessionId or returns the standard not-found error entry. */
  private _resolveSession(id: string): { agent: Agent } | { sessionId: string; error: string } {
    const agent = this._agents.find(a => a.id === id && !this._removingSessionIds.has(a.id));
    if (agent) return { agent };
    return { sessionId: id, error: `Unknown subagent session: ${id}` };
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
    const snapshot = agent.snapshot();
    let ancestorId = agent.parentId;
    while (ancestorId !== undefined) {
      let descendants = this._descendantsByAncestor.get(ancestorId);
      if (!descendants) {
        descendants = new Map();
        this._descendantsByAncestor.set(ancestorId, descendants);
      }
      descendants.set(agent.id, snapshot);
      ancestorId = this._agents.find(candidate => candidate.id === ancestorId)?.parentId;
    }

    for (const listener of this._updateListeners) listener(agent, kind);
    for (const group of this._groups.values()) group.handleAgentUpdate(agent.id, kind);

    if (kind !== "status") return;
    if (this._pendingFinalize.has(agent.id)) return;

    const outcome = status.kind === "done" ? status.outcome : undefined;
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

function projectConversationMessages(messages: readonly unknown[]): SessionConversationMessage[] {
  const projected: SessionConversationMessage[] = [];
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    const role = message.role;
    const content = Array.isArray(message.content) ? message.content : [];
    if (role === "user" || role === "assistant") {
      const text = projectTextContent(content, 1_200);
      if (text) projected.push({ role, text });
      if (role === "assistant") {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const block = part as Record<string, unknown>;
          if (block.type !== "toolCall" || typeof block.name !== "string") continue;
          const argumentsText = summarizeToolArguments(block.arguments);
          projected.push({
            role: "tool",
            text: argumentsText ? `${block.name} ${argumentsText}` : block.name,
            toolName: block.name,
          });
        }
      }
    } else if (role === "toolResult") {
      const text = projectTextContent(content, 400);
      const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
      projected.push({
        role: "toolResult",
        text: text || toolName || "Tool result",
        ...(toolName ? { toolName } : {}),
        ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
      });
    }
  }
  return projected;
}

function projectTextContent(content: readonly unknown[], maxLength: number): string {
  let text = "";
  let truncated = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as Record<string, unknown>;
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const separator = text ? "\n" : "";
    const remaining = maxLength - text.length - separator.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    text += separator + block.text.slice(0, remaining);
    if (block.text.length > remaining) {
      truncated = true;
      break;
    }
  }
  return truncated ? `${text}…` : text;
}

function summarizeToolArguments(value: unknown): string {
  if (value === undefined) return "";
  try {
    const text = JSON.stringify(value);
    if (!text) return "";
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  } catch {
    return "";
  }
}
