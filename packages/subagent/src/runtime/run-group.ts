import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind, AgentView } from "../domain/agent-view.js";
import { projectAgentView } from "../view/project-agent-view.js";
import { getSubagentDisplaySettings } from "../view/view-helpers.js";
import type { SubagentDisplaySettings } from "../ui/settings.js";
import { timingStart, timingSync } from "./timing.js";

const MESSAGE_UPDATE_THROTTLE_MS = 100;
const ANIMATION_UPDATE_INTERVAL_MS = 120;

export interface RunUpdate {
  /** Root sessions in input order. */
  sessions: AgentView[];
  /** Roots followed by every descendant currently reachable from a root, in pre-order. */
  tree: AgentView[];
  active: boolean;
}

export type RunUpdateListener = (update: RunUpdate) => void;

type Entry =
  | { kind: "agent"; inputIndex: number; resumed: boolean; agent: Agent }
  | { kind: "static"; inputIndex: number; resumed: boolean; view: AgentView };

export interface RunGroupOptions {
  groupId: string;
  listener?: RunUpdateListener;
  /**
   * Returns the live tree (roots + descendants in pre-order) for the given root ids.
   * Provided by the manager so the group can compute progress views without owning
   * the agent catalog itself.
   */
  walkTree: (rootIds: string[]) => AgentView[];
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

  constructor(private readonly opts: RunGroupOptions) {}

  get groupId(): string { return this.opts.groupId }
  get entryCount(): number { return this._entries.length }

  addAgent(agent: Agent, inputIndex: number, resumed: boolean): void {
    this._entries.push({ kind: "agent", inputIndex, resumed, agent });
    this._rootIds.add(agent.id);
    this._refreshTreeIds();
  }

  addStaticView(view: AgentView, inputIndex: number, resumed: boolean): void {
    this._entries.push({ kind: "static", inputIndex, resumed, view });
  }

  /** Whether the given agent currently belongs to this group's subtree. */
  contains(agentId: string): boolean {
    return this._treeIds.has(agentId);
  }

  /** Root sessions in input order. */
  rootSessions(): AgentView[] {
    const display = getSubagentDisplaySettings();
    return this._sortedEntries().map(entry => this._project(entry, display));
  }

  /** Roots followed by every descendant, in pre-order. */
  tree(): AgentView[] {
    const display = getSubagentDisplaySettings();
    const out: AgentView[] = [];
    for (const entry of this._sortedEntries()) {
      const root = this._project(entry, display);
      out.push(root);
      if (entry.kind !== "agent") continue;
      // walkTree returns [root, ...descendants]; skip the root since we just pushed our own projection.
      for (const node of this.opts.walkTree([entry.agent.id])) {
        if (node.id === entry.agent.id) continue;
        out.push(node);
      }
    }
    return out;
  }

  private _sortedEntries(): Entry[] {
    return this._entries.slice().sort((a, b) => a.inputIndex - b.inputIndex);
  }

  private _project(entry: Entry, display: SubagentDisplaySettings): AgentView {
    return entry.kind === "agent"
      ? { ...projectAgentView(entry.agent, display, { inputIndex: entry.inputIndex }), resumed: entry.resumed }
      : { ...entry.view, resumed: entry.resumed };
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
    if (!this.opts.listener) return;

    const end = timingStart("manager.emitRunUpdate", { groupId: this.opts.groupId, entries: this._entries.length });
    const sessions = this.rootSessions();
    const tree = this.tree();
    const active = tree.some(s => s.status.kind === "queued" || s.status.kind === "running");
    timingSync("manager.listener", { groupId: this.opts.groupId, sessionCount: sessions.length, treeCount: tree.length, active }, () => {
      this.opts.listener?.({ sessions, tree, active });
    });
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
