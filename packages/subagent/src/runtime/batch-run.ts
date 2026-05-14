import type { Agent } from "../domain/agent.js";
import type { AgentUpdateKind, AgentView, SubagentBatchUpdate } from "../domain/agent-view.js";
import { timingStart, timingSync } from "./timing.js";

const MESSAGE_UPDATE_THROTTLE_MS = 100;
const ANIMATION_UPDATE_INTERVAL_MS = 120;

export type BatchUpdateListener = (update: SubagentBatchUpdate) => void;

type Entry =
  | { kind: "agent"; inputIndex: number; resumed: boolean; agent: Agent }
  | { kind: "static"; inputIndex: number; resumed: boolean; view: AgentView };

export class BatchRun {
  private readonly _entries: Entry[] = [];
  private pendingMessageTimer?: NodeJS.Timeout;
  private animationTimer?: NodeJS.Timeout;

  constructor(
    readonly groupId: string,
    private readonly listener?: BatchUpdateListener,
  ) {}

  get entryCount(): number { return this._entries.length }

  addAgent(agent: Agent, inputIndex: number, resumed: boolean): void {
    this._entries.push({ kind: "agent", inputIndex, resumed, agent });
  }

  addStaticView(view: AgentView, inputIndex: number, resumed: boolean): void {
    this._entries.push({ kind: "static", inputIndex, resumed, view });
  }

  sessions(): AgentView[] {
    return this._entries
      .slice()
      .sort((a, b) => a.inputIndex - b.inputIndex)
      .map(entry => entry.kind === "agent"
        ? { ...entry.agent.toView(entry.inputIndex), resumed: entry.resumed }
        : { ...entry.view, resumed: entry.resumed });
  }

  handleAgentUpdate(kind: AgentUpdateKind): void {
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
    if (!this.listener) return;

    const end = timingStart("manager.emitBatchUpdate", { groupId: this.groupId, entries: this._entries.length });
    const sessions = this.sessions();
    const active = sessions.some(s => s.status.kind === "queued" || s.status.kind === "running");
    timingSync("manager.listener", { groupId: this.groupId, sessionCount: sessions.length, active }, () => this.listener?.({ sessions, active }));
    this.scheduleAnimationUpdate(active);
    end({ active, sessionCount: sessions.length });
  }

  dispose(): void {
    this.clearPendingMessageUpdate();
    this.clearAnimationUpdate();
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
