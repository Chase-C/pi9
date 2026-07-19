import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Agent, type RunBinding } from "../domain/agent.js";
import type { AgentUpdateKind } from "../domain/agent-lifecycle.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import type { ConversationId } from "../domain/conversation-id.js";
import type { ParentRun } from "../domain/parent-run.js";
import type { RunId } from "../domain/run-id.js";
import { AgentRegistry } from "../domain/agent-registry.js";
import type { TaskRequest } from "../schema.js";
import { AttemptRunner, type AgentRunner } from "./attempt-runner.js";
import { ConversationIdAllocator } from "./conversation-id-allocator.js";
import { RunIdAllocator } from "./run-id-allocator.js";

export type AgentUpdateListener = (agent: Agent, kind: AgentUpdateKind) => void;
export type { AgentRunner } from "./attempt-runner.js";

export type OrderedStartOutcome =
  | { readonly ok: true; readonly inputIndex: number; readonly conversationId: ConversationId; readonly runId: RunId }
  | { readonly ok: false; readonly inputIndex: number; readonly error: string };
export interface RunHandle { readonly starts: readonly OrderedStartOutcome[]; readonly completion: Promise<readonly OrderedStartOutcome[]> }
export interface JoinProjection { readonly conversationId: ConversationId; readonly runId: RunId; readonly status: AgentSnapshot["runs"][number]["status"] }
export interface JoinBinding { readonly runIds: readonly RunId[]; readonly completion: Promise<void>; project(): readonly JoinProjection[]; acknowledge(): void; release(): void }
export interface RemoveResult { removed: number; aborted: number; conversationIds: ConversationId[]; errors: Array<{ conversationId: string; error: string }> }

/** Owns the conversation catalog and the exact-run index. */
export class AgentManager {
  private readonly conversations = new Map<ConversationId, Agent>();
  private readonly runs = new Map<RunId, Agent>();
  private readonly listeners = new Set<AgentUpdateListener>();
  private readonly conversationIds = new ConversationIdAllocator();
  private readonly runIds = new RunIdAllocator();
  private readonly _runner: AttemptRunner;

  constructor(readonly registry: AgentRegistry, maxRunning = 4, runner?: AgentRunner, private _maxConversations = 100) {
    this._runner = new AttemptRunner({ maxRunning, ...(runner ? { runner } : {}), isTracked: id => this.conversations.has(id as ConversationId) });
  }
  get runner(): AttemptRunner { return this._runner; }
  get maxConversations(): number { return this._maxConversations; }
  configure(options: { maxRunning?: number; maxConversations?: number }): void {
    this._runner.configure(options);
    if (options.maxConversations !== undefined) this._maxConversations = options.maxConversations;
  }
  onAgentUpdate(listener: AgentUpdateListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  listConversations(): AgentSnapshot[] { return [...this.conversations.values()].map(a => a.snapshot()); }
  conversation(conversationId: string): AgentSnapshot { return this.requireConversation(conversationId).snapshot(); }

  /** Resolves and reserves the complete batch synchronously; executions never inherit caller cancellation. */
  startRun(ctx: ExtensionContext, tasks: readonly TaskRequest[], options: { parent?: ParentRun } = {}): RunHandle {
    const starts: OrderedStartOutcome[] = [];
    const executions: Promise<unknown>[] = [];
    let reserved = this.conversations.size;
    for (let inputIndex = 0; inputIndex < tasks.length; inputIndex++) {
      const task = tasks[inputIndex];
      let agent: Agent | undefined;
      let runId: RunId | undefined;
      let error: string | undefined;
      if (task.kind === "spawn") {
        const config = this.registry.agents.get(task.agent);
        if (!config) error = `Unknown agent: ${task.agent}.`;
        else if (reserved >= this.maxConversations) error = this.capacityError();
        else {
          const conversationId = this.conversationIds.allocate(); runId = this.runIds.allocate();
          if (!conversationId || !runId) error = "Conversation or run ID space exhausted.";
          else { agent = new Agent(conversationId, runId, config, task, (a, k) => this.updated(a, k), options); this.conversations.set(conversationId, agent); reserved++; }
        }
      } else {
        agent = this.conversations.get(task.conversationId);
        if (!agent) error = `Unknown conversation: ${task.conversationId}.`;
        else if (!agent.canResume) error = `Conversation ${task.conversationId} cannot be resumed.`;
        else { runId = this.runIds.allocate(); if (!runId) error = "Run ID space exhausted."; else agent.beginResume(runId, task.prompt); }
      }
      if (!agent || !runId || error) { starts.push({ ok: false, inputIndex, error: error ?? "Could not start run." }); continue; }
      this.runs.set(runId, agent);
      // Publish queued only after both indexes can resolve the event identities.
      this.updated(agent, "status");
      starts.push({ ok: true, inputIndex, conversationId: agent.conversationId, runId });
      executions.push(this._runner.run(ctx, undefined, agent, agent.requireCurrentAttempt()));
    }
    return { starts, completion: Promise.allSettled(executions).then(() => starts) };
  }

  /** Manager-owned, event-driven binding of exact roots and their exact-run spawn subtree. */
  bindJoin(runIds: readonly RunId[]): JoinBinding {
    const roots = runIds.map(id => { const agent = this.runs.get(id); if (!agent) throw new Error(`Unknown or removed run: ${id}.`); return { id, agent }; });
    const bindings = new Map<RunId, { agent: Agent; binding: RunBinding }>();
    let released = false; let checking = true; let resolve!: () => void;
    const completion = new Promise<void>(done => { resolve = done; });
    const add = (id: RunId, agent: Agent) => { if (!bindings.has(id)) bindings.set(id, { agent, binding: agent.bindRun(id) }); };
    const discover = () => {
      let changed: boolean;
      do {
        changed = false;
        for (const agent of this.conversations.values()) {
          if (!agent.parent || !bindings.has(agent.parent.runId)) continue;
          // A spawn conversation contributes its initial run only. Resumes are not descendants
          // of the spawning run; their own children are linked to their exact run independently.
          const run = agent.runHistory[0];
          if (run && !bindings.has(run.runId)) { add(run.runId, agent); changed = true; }
        }
      } while (changed);
    };
    const ordered = () => {
      const result: Array<{ agent: Agent; binding: RunBinding }> = []; const emitted = new Set<RunId>();
      const visit = (id: RunId) => { const item = bindings.get(id); if (!item || emitted.has(id)) return; emitted.add(id); result.push(item); for (const [childId, child] of bindings) if (child.agent.parent?.runId === id) visit(childId); };
      for (const root of roots) visit(root.id);
      return result;
    };
    const check = () => {
      if (released || checking) return; checking = true; discover(); const all = ordered();
      if (all.every(item => item.binding.snapshot().status.kind === "done")) resolve();
      checking = false;
    };
    // Subscribe before initial discovery so a spawn/terminal event cannot fall in the bind race.
    const unsubscribe = this.onAgentUpdate(() => check());
    for (const root of roots) add(root.id, root.agent); checking = false; check();
    const release = () => { if (released) return; released = true; unsubscribe(); for (const item of bindings.values()) item.binding.release(); };
    return {
      get runIds() { return ordered().map(item => item.binding.runId); }, completion,
      project: () => ordered().map(item => ({ conversationId: item.agent.conversationId, runId: item.binding.runId, status: item.binding.snapshot().status })),
      acknowledge: () => { for (const item of ordered()) if (item.binding.snapshot().status.kind === "done") item.binding.acknowledge(); },
      release,
    };
  }

  removeConversation(conversationId: string): RemoveResult { return this.removeConversations([conversationId]); }
  removeConversations(ids: readonly string[]): RemoveResult {
    const unique = [...new Set(ids)]; const removed: ConversationId[] = []; const errors: Array<{ conversationId: string; error: string }> = []; let aborted = 0;
    for (const id of unique) {
      const agent = this.conversations.get(id as ConversationId);
      if (!agent) { errors.push({ conversationId: id, error: `Unknown conversation: ${id}.` }); continue; }
      if (agent.hasCurrentAttempt) aborted++;
      const runIds = agent.runHistory.map(r => r.runId);
      void agent.abort("Conversation removed.");
      this.conversations.delete(agent.conversationId); for (const runId of runIds) this.runs.delete(runId);
      removed.push(agent.conversationId);
    }
    return { removed: removed.length, aborted, conversationIds: removed, errors };
  }
  private requireConversation(id: string): Agent { const found = this.conversations.get(id as ConversationId); if (!found) throw new Error(`Unknown conversation: ${id}.`); return found; }
  private capacityError(): string { const removable = [...this.conversations.values()].filter(a => !a.hasCurrentAttempt).map(a => a.conversationId); return `Conversation capacity (${this.maxConversations}) reached. Remove terminal conversations${removable.length ? `: ${removable.join(", ")}` : " before spawning more"}.`; }
  private updated(agent: Agent, kind: AgentUpdateKind): void { for (const listener of this.listeners) listener(agent, kind); }
}
