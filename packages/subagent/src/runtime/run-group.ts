import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind } from "../domain/agent-lifecycle.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";
import { timingStart } from "./timing.js";

const MESSAGE_UPDATE_THROTTLE_MS = 100;
const ANIMATION_UPDATE_INTERVAL_MS = 120;

export interface RunUpdate {
  /** Root sessions in input order. */
  sessions: AgentSnapshot[];
  /** Roots followed by every descendant currently reachable from a root, in pre-order. */
  tree: AgentSnapshot[];
  active: boolean;
}

export type RunUpdateListener = (update: RunUpdate) => void;

type Entry =
  | { kind: "agent"; inputIndex: number; agent: Agent }
  | { kind: "static"; inputIndex: number; view: AgentSnapshot };

export interface RunGroupOptions {
  groupId: string;
  onUpdate?: RunUpdateListener;
  /**
   * Returns the live tree (roots + descendants in pre-order) for the given root ids.
   * Provided by the manager so the group can compute progress views without owning
   * the agent catalog itself.
   */
  walkTree: (rootIds: string[]) => AgentSnapshot[];
}

/**
 * One run group per `startRun` call. Owns its entries, throttles update emission, and
 * projects the live subtree for the tool layer. Subscribes to manager-wide agent updates
 * via {@link handleAgentUpdate}; the manager calls it for every update and the group
 * filters down to its own subtree.
 */
export class RunGroup {

  private readonly _entries: Entry[] = [];
  private pendingMessageTimer?: NodeJS.Timeout;
  private animationTimer?: NodeJS.Timeout;
  private readonly _rootIds = new Set<string>();
  private _treeIds = new Set<string>();

  constructor(private readonly opts: RunGroupOptions) { }

  addAgent(agent: Agent, inputIndex: number): void {
    this._entries.push({ kind: "agent", inputIndex, agent });
    this._rootIds.add(agent.id);
    this._refreshTreeIds();
  }

  addStaticView(view: AgentSnapshot, inputIndex: number): void {
    this._entries.push({ kind: "static", inputIndex, view });
  }

  /** Whether the given agent currently belongs to this group's subtree. */
  contains(agentId: string): boolean {
    return this._treeIds.has(agentId);
  }

  /** Root sessions in input order. */
  rootSessions(): AgentSnapshot[] {
    return this._sortedEntries().map(entry => this._project(entry));
  }

  /** Roots followed by every descendant, in pre-order. */
  tree(): AgentSnapshot[] {
    const out: AgentSnapshot[] = [];
    const seen = new Set<string>();
    for (const entry of this._sortedEntries()) {
      const root = this._project(entry);
      if (seen.has(root.id)) continue;
      seen.add(root.id);
      out.push(root);
      if (entry.kind !== "agent") continue;
      // walkTree returns [root, ...descendants]; skip the root since we just pushed our own projection.
      for (const node of this.opts.walkTree([entry.agent.id])) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        out.push(node);
      }
    }
    return out;
  }

  private _sortedEntries(): Entry[] {
    return this._entries.slice().sort((a, b) => a.inputIndex - b.inputIndex);
  }

  private _project(entry: Entry): AgentSnapshot {
    if (entry.kind === "agent") {
      return entry.agent.snapshot({ inputIndex: entry.inputIndex, includeResumed: true });
    }
    return {
      ...entry.view,
      resumed: entry.view.status.kind === "done" && entry.view.status.resumed === true,
    };
  }

  /**
   * Manager calls this on every agent update. The group decides whether the update
   * matters to its subtree and how to schedule an emit.
   */
  handleAgentUpdate(agentId: string, kind: AgentUpdateKind): void {
    if (kind === "status") {
      // Tree shape may have changed (e.g. a descendant was just adopted): refresh ids.
      this._refreshTreeIds();
    }
    if (!this._treeIds.has(agentId)) return;
    if (kind === "message") {
      this.clearAnimationUpdate();
      if (!this.pendingMessageTimer) {
        this.pendingMessageTimer = setTimeout(() => {
          this.pendingMessageTimer = undefined;
          this.emit();
        }, MESSAGE_UPDATE_THROTTLE_MS);
      }
      return;
    }
    this.clearPendingMessageUpdate();
    this.emit();
  }

  flush(): void {
    if (!this.clearPendingMessageUpdate()) return;
    this.emit();
  }

  emit(): void {
    if (!this.opts.onUpdate) return;

    const end = timingStart("manager.emitRunUpdate", { groupId: this.opts.groupId, entries: this._entries.length });
    const sessions = this.rootSessions();
    const tree = this.tree();
    const active = tree.some(s => s.status.kind === "queued" || s.status.kind === "running");
    this.opts.onUpdate?.({ sessions, tree, active });
    this.scheduleAnimationUpdate(active);
    end({ active, sessionCount: sessions.length, treeCount: tree.length });
  }

  dispose(): void {
    this.clearPendingMessageUpdate();
    this.clearAnimationUpdate();
  }

  private _refreshTreeIds(): void {
    if (this._rootIds.size === 0) {
      this._treeIds = new Set();
      return;
    }
    const ids = new Set<string>();
    for (const node of this.opts.walkTree(Array.from(this._rootIds))) ids.add(node.id);
    for (const id of this._rootIds) ids.add(id);
    this._treeIds = ids;
  }

  private clearPendingMessageUpdate(): boolean {
    if (!this.pendingMessageTimer) return false;
    clearTimeout(this.pendingMessageTimer);
    this.pendingMessageTimer = undefined;
    return true;
  }

  private scheduleAnimationUpdate(active: boolean): void {
    if (!active) {
      this.clearAnimationUpdate();
      return;
    }
    if (this.animationTimer) return;
    this.animationTimer = setTimeout(() => {
      this.animationTimer = undefined;
      this.emit();
    }, ANIMATION_UPDATE_INTERVAL_MS);
    this.animationTimer.unref?.();
  }

  private clearAnimationUpdate(): void {
    if (!this.animationTimer) return;
    clearTimeout(this.animationTimer);
    this.animationTimer = undefined;
  }
}
