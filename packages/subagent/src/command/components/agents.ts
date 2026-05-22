import type { Component, TUI } from "@earendil-works/pi-tui";

import type { AgentConfig } from "../../domain/agent-config.js";
import { formatAgentConfigInspect, formatAgentConfigSummary } from "../../view/format.js";
import {
  agentInspectHelp,
  agentListHelp,
  clamp,
  fitLinesToWidth,
  isCancelKey,
  isDownKey,
  isEnterKey,
  isUpKey,
  type SubagentKeybindings,
  type SubagentSessionsTheme,
} from "../input.js";
import type { SubagentsCommandResult } from "./result-types.js";

export class SubagentAgentsComponent implements Component {
  private selected = 0;
  private mode: "list" | "inspect" = "list";

  constructor(
    private readonly agents: AgentConfig[],
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: SubagentSessionsTheme,
    private readonly keybindings: SubagentKeybindings,
    private readonly done: (result?: SubagentsCommandResult) => void,
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    if (this.agents.length === 0) return fitLinesToWidth([this.accent("Subagent Agents"), "No configured subagent agents.", this.dim(agentListHelp())], width);

    this.selected = clamp(this.selected, 0, this.agents.length - 1);
    if (this.mode === "inspect") {
      const agent = this.agents[this.selected];
      return fitLinesToWidth([
        this.accent("Agent Definition"),
        ...formatAgentConfigInspect(agent).map(line => `  ${line}`),
        this.dim(agentInspectHelp()),
      ], width);
    }

    return fitLinesToWidth([
      this.accent("Subagent Agents"),
      ...this.agents.map((agent, index) => {
        const prefix = index === this.selected ? "> " : "  ";
        const line = `${prefix}${formatAgentConfigSummary(agent)}`;
        return index === this.selected ? this.accent(line) : line;
      }),
      this.dim(agentListHelp()),
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
    if (this.mode === "inspect" && (data === "b" || data === "B")) {
      this.mode = "list";
      this.tui.requestRender();
      return;
    }
    if (isEnterKey(data, this.keybindings) && this.agents.length > 0) {
      this.mode = "inspect";
      this.tui.requestRender();
      return;
    }
    if (this.mode === "list" && isUpKey(data, this.keybindings)) {
      this.selected = clamp(this.selected - 1, 0, Math.max(0, this.agents.length - 1));
      this.tui.requestRender();
      return;
    }
    if (this.mode === "list" && isDownKey(data, this.keybindings)) {
      this.selected = clamp(this.selected + 1, 0, Math.max(0, this.agents.length - 1));
      this.tui.requestRender();
    }
  }

  private accent(text: string) {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }

  private dim(text: string) {
    return this.theme.fg?.("dim", text) ?? text;
  }
}
