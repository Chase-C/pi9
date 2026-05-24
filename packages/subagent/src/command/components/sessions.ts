import type { Component, TUI } from "@earendil-works/pi-tui";

import type { AgentSnapshot } from "../../domain/agent-snapshot.js";
import type { AgentManager } from "../../runtime/agent-manager.js";
import type { SubagentDisplaySettings } from "../../config/settings.js";
import { formatSubagentSessionInspect, formatSubagentSessionSummary } from "../../view/format.js";
import {
  clamp,
  fitLinesToWidth,
  inspectHelp,
  isCancelKey,
  isDownKey,
  isEnterKey,
  isUpKey,
  listHelp,
  type SubagentKeybindings,
  type SubagentSessionsTheme,
} from "../input.js";
import type { SubagentsCommandResult } from "./result-types.js";

export class SubagentSessionsComponent implements Component {
  private selected = 0;
  private mode: "list" | "inspect" = "list";

  constructor(
    private readonly agentManager: AgentManager,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: SubagentSessionsTheme,
    private readonly keybindings: SubagentKeybindings,
    private readonly display: SubagentDisplaySettings,
    private readonly notify: (message: string, level?: string) => void,
    private readonly done: (result?: SubagentsCommandResult) => void,
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    const sessions = this.sessions;
    if (sessions.length === 0) return fitLinesToWidth([this.accent("Subagent Sessions"), "No active or retained subagent sessions."], width);

    this.selected = clamp(this.selected, 0, sessions.length - 1);
    if (this.mode === "inspect") {
      const session = sessions[this.selected];
      return fitLinesToWidth([
        this.accent("Subagent Session"),
        ...formatSubagentSessionInspect(session, Date.now(), this.display).map(line => `  ${line}`),
        this.dim(inspectHelp(session)),
      ], width);
    }

    return fitLinesToWidth([
      this.accent("Subagent Sessions"),
      ...sessions.map((session, index) => {
        const prefix = index === this.selected ? "> " : "  ";
        const line = `${prefix}${formatSubagentSessionSummary(session)}`;
        return index === this.selected ? this.accent(line) : line;
      }),
      this.dim(listHelp(sessions[this.selected])),
    ], width);
  }

  handleInput(data: string): void {
    const sessions = this.sessions;
    if (isCancelKey(data, this.keybindings)) {
      this.done();
      return;
    }
    if (this.mode === "inspect" && (data === "b" || data === "B")) {
      this.mode = "list";
      this.tui.requestRender();
      return;
    }
    if (data === "c" || data === "C") {
      this.clearSelected();
      return;
    }
    if (data === "r" || data === "R") {
      this.resumeSelected();
      return;
    }
    if (isEnterKey(data, this.keybindings) && sessions.length > 0) {
      this.mode = "inspect";
      this.tui.requestRender();
      return;
    }
    if (this.mode === "list" && isUpKey(data, this.keybindings)) {
      this.selected = clamp(this.selected - 1, 0, Math.max(0, sessions.length - 1));
      this.tui.requestRender();
      return;
    }
    if (this.mode === "list" && isDownKey(data, this.keybindings)) {
      this.selected = clamp(this.selected + 1, 0, Math.max(0, sessions.length - 1));
      this.tui.requestRender();
    }
  }

  private resumeSelected() {
    const session = this.sessions[this.selected];
    if (!session) return;
    if (!session.capabilities.canResume) {
      const detail = session.status.kind === "done" ? session.status.outcome : session.status.kind;
      this.notify(`Subagent session ${session.id} is ${detail} and cannot be resumed.`, "warning");
      return;
    }
    this.done({ action: "resume", sessionId: session.id, agent: session.config.name });
  }

  private clearSelected() {
    const session = this.sessions[this.selected];
    if (!session) return;
    if (!session.capabilities.canClear) {
      const detail = session.status.kind === "done" ? session.status.outcome : session.status.kind;
      this.notify(`Subagent session ${session.id} is ${detail} and cannot be removed.`, "warning");
      return;
    }

    void this.agentManager.remove({ sessionIds: [session.id] }).then(
      result => {
        if (result.removed > 0) this.notify(`Removed subagent session ${session.id}.`, "success");
        else this.notify(`Subagent session ${session.id} was already gone.`, "warning");
      },
      error => this.notify(`Failed to remove subagent session ${session.id}: ${error instanceof Error ? error.message : String(error)}`, "warning"),
    );

    const sessions = this.sessions;
    if (sessions.length === 0) {
      this.done();
      return;
    }
    this.selected = clamp(this.selected, 0, sessions.length - 1);
    this.mode = "list";
    this.tui.requestRender();
  }

  private get sessions(): AgentSnapshot[] {
    return this.agentManager.listSessions();
  }

  private accent(text: string) {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }

  private dim(text: string) {
    return this.theme.fg?.("dim", text) ?? text;
  }
}
