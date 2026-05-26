import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "../../domain/agent-config.js";
import { formatAgentConfigInspect, formatAgentConfigSummary } from "../../view/format.js";
import {
  accent,
  agentInspectHelp,
  agentListHelp,
  clamp,
  dim,
  fitLinesToWidth,
  handleListInspectNavigation,
  isCancelKey,
  selectedListLines,
  type ListInspectState,
  type SubagentKeybindings,
} from "../input.js";
import type { SubagentsCommandResult } from "./result-types.js";

export class SubagentAgentsComponent implements Component {
  private readonly state: ListInspectState = { selected: 0, mode: "list" };

  constructor(
    private readonly agents: AgentConfig[],
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
    private readonly keybindings: SubagentKeybindings,
    private readonly done: (result?: SubagentsCommandResult) => void,
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    if (this.agents.length === 0) {
      return fitLinesToWidth([accent(this.theme, "Subagent Agents"), "No configured subagent agents.", dim(this.theme, agentListHelp())], width);
    }

    this.state.selected = clamp(this.state.selected, 0, this.agents.length - 1);
    if (this.state.mode === "inspect") {
      const agent = this.agents[this.state.selected];
      return fitLinesToWidth([
        accent(this.theme, "Agent Definition"),
        ...formatAgentConfigInspect(agent).map(line => `  ${line}`),
        dim(this.theme, agentInspectHelp()),
      ], width);
    }

    return fitLinesToWidth([
      accent(this.theme, "Subagent Agents"),
      ...selectedListLines(this.agents, this.state.selected, formatAgentConfigSummary, this.theme),
      dim(this.theme, agentListHelp()),
    ], width);
  }

  handleInput(data: string): void {
    if (isCancelKey(data, this.keybindings)) {
      this.done();
      return;
    }
    if (data === "s" || data === "S") {
      this.done({ action: "settings" });
      return;
    }
    handleListInspectNavigation(data, this.state, this.agents.length, this.keybindings, () => this.tui.requestRender());
  }
}
