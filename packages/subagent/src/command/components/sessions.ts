import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { AgentSnapshot } from "../../domain/agent-snapshot.js";
import type { AgentManager } from "../../runtime/agent-manager.js";
import type { SubagentDisplaySettings } from "../../config/settings.js";
import { formatSubagentSessionInspect, formatSubagentSessionSummary } from "../../view/format.js";
import {
  accent,
  clamp,
  dim,
  fitLinesToWidth,
  handleListInspectNavigation,
  inspectHelp,
  isCancelKey,
  listHelp,
  selectedListLines,
  type ListInspectState,
  type SubagentKeybindings,
} from "../input.js";
import type { SubagentsCommandResult } from "./result-types.js";

export class SubagentSessionsComponent implements Component {
  private readonly state: ListInspectState = { selected: 0, mode: "list" };

  constructor(
    private readonly agentManager: AgentManager,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
    private readonly keybindings: SubagentKeybindings,
    private readonly display: SubagentDisplaySettings,
    private readonly notify: (message: string, level?: string) => void,
    private readonly done: (result?: SubagentsCommandResult) => void,
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    const sessions = this.sessions;
    if (sessions.length === 0) return fitLinesToWidth([accent(this.theme, "Subagent Sessions"), "No active or retained subagent sessions."], width);

    this.state.selected = clamp(this.state.selected, 0, sessions.length - 1);
    if (this.state.mode === "inspect") {
      const session = sessions[this.state.selected];
      return fitLinesToWidth([
        accent(this.theme, "Subagent Session"),
        ...formatSubagentSessionInspect(session, Date.now(), this.display).map(line => `  ${line}`),
        dim(this.theme, inspectHelp(session)),
      ], width);
    }

    return fitLinesToWidth([
      accent(this.theme, "Subagent Sessions"),
      ...selectedListLines(sessions, this.state.selected, formatSubagentSessionSummary, this.theme),
      dim(this.theme, listHelp(sessions[this.state.selected])),
    ], width);
  }

  handleInput(data: string): void {
    const sessions = this.sessions;
    if (isCancelKey(data, this.keybindings)) {
      this.done();
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
    handleListInspectNavigation(data, this.state, sessions.length, this.keybindings, () => this.tui.requestRender());
  }

  private resumeSelected() {
    const session = this.sessions[this.state.selected];
    if (!session) return;
    if (!session.capabilities.canResume) {
      const detail = session.status.kind === "done" ? session.status.outcome : session.status.kind;
      this.notify(`Subagent session ${session.id} is ${detail} and cannot be resumed.`, "warning");
      return;
    }
    this.done({ action: "resume", sessionId: session.id, agent: session.config.name });
  }

  private clearSelected() {
    const session = this.sessions[this.state.selected];
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
    this.state.selected = clamp(this.state.selected, 0, sessions.length - 1);
    this.state.mode = "list";
    this.tui.requestRender();
  }

  private get sessions(): AgentSnapshot[] {
    return this.agentManager.listSessions();
  }
}
