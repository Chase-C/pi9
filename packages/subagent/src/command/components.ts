import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { SettingsList, type Component, type SettingItem, type TUI } from "@mariozechner/pi-tui";

import type { AgentConfig } from "../domain/agent-config.js";
import type { AgentView } from "../domain/agent-view.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import {
  formatAgentConfigInspect,
  formatAgentConfigSummary,
  formatSubagentSessionInspect,
  formatSubagentSessionSummary,
} from "../view/format.js";
import { canClearSubagentSession, canResumeSubagentSession } from "../view/view-helpers.js";
import type { SubagentUiSettings, WidgetPlacement } from "../ui/settings.js";
import {
  agentInspectHelp,
  agentListHelp,
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
} from "./input.js";

export type SubagentResumeCommandResult = { action: "resume"; sessionId: string; agent: string };
export type SubagentsCommandResult = SubagentResumeCommandResult | { action: "settings" };

export class SubagentSettingsComponent implements Component {
  private readonly settingsList: SettingsList;
  private readonly theme: SubagentSessionsTheme;

  constructor(
    settings: SubagentUiSettings,
    theme: SubagentSessionsTheme,
    private readonly keybindings: SubagentKeybindings,
    onChange: (placement: WidgetPlacement) => void,
    private readonly done: () => void,
  ) {
    const items: SettingItem[] = [{
      id: "widgetPlacement",
      label: "Widget placement",
      currentValue: settings.widgetPlacement,
      values: ["belowEditor", "aboveEditor", "off"],
      description: "Values: belowEditor, aboveEditor, off. off hides only the progress widget.",
    }];
    this.settingsList = new SettingsList(
      items,
      6,
      getSubagentSettingsListTheme(theme),
      (_id, newValue) => onChange(newValue as WidgetPlacement),
      done,
    );
    this.theme = theme;
  }

  invalidate(): void { this.settingsList.invalidate(); }

  render(width: number): string[] {
    return fitLinesToWidth([this.accent("Subagent Settings"), "", ...this.settingsList.render(width)], width);
  }

  handleInput(data: string): void {
    if (isCancelKey(data, this.keybindings)) {
      this.done();
      return;
    }
    this.settingsList.handleInput(data);
  }

  private accent(text: string) {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }
}

function getSubagentSettingsListTheme(theme: SubagentSessionsTheme) {
  try {
    return getSettingsListTheme();
  } catch {
    return {
      label: (text: string, selected: boolean) => selected ? (theme.bold?.(text) ?? text) : text,
      value: (text: string) => text,
      description: (text: string) => theme.fg?.("dim", text) ?? text,
      cursor: "> ",
      hint: (text: string) => theme.fg?.("dim", text) ?? text,
    };
  }
}

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

export class SubagentSessionsComponent implements Component {
  private selected = 0;
  private mode: "list" | "inspect" = "list";

  constructor(
    private readonly agentManager: AgentManager,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: SubagentSessionsTheme,
    private readonly keybindings: SubagentKeybindings,
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
        ...formatSubagentSessionInspect(session).map(line => `  ${line}`),
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
    if (!canResumeSubagentSession(session)) {
      const detail = session.status.kind === "done" ? session.status.outcome : session.status.kind;
      this.notify(`Subagent session ${session.id} is ${detail} and cannot be resumed.`, "warning");
      return;
    }
    this.done({ action: "resume", sessionId: session.id, agent: session.config.name });
  }

  private clearSelected() {
    const session = this.sessions[this.selected];
    if (!session) return;
    if (!canClearSubagentSession(session)) {
      const detail = session.status.kind === "done" ? session.status.outcome : session.status.kind;
      this.notify(`Subagent session ${session.id} is ${detail} and cannot be cleared.`, "warning");
      return;
    }

    void this.agentManager.remove({ sessionIds: [session.id] }).then(
      result => {
        if (result.removed > 0) this.notify(`Cleared subagent session ${session.id}.`, "success");
        else this.notify(`Subagent session ${session.id} was already gone.`, "warning");
      },
      error => this.notify(`Failed to clear subagent session ${session.id}: ${error instanceof Error ? error.message : String(error)}`, "warning"),
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

  private get sessions(): AgentView[] {
    return this.agentManager.sessions;
  }

  private accent(text: string) {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }

  private dim(text: string) {
    return this.theme.fg?.("dim", text) ?? text;
  }
}

export class SubagentResumeLoader implements Component {
  private readonly controller = new AbortController();

  constructor(private readonly theme: SubagentSessionsTheme, private readonly keybindings: SubagentKeybindings, private readonly message: string) { }

  get signal() { return this.controller.signal; }

  invalidate(): void { }

  render(width: number) { return fitLinesToWidth([this.accent(this.message), this.dim("esc cancel")], width); }

  handleInput(data: string) {
    if (isCancelKey(data, this.keybindings)) this.controller.abort();
  }

  dispose(): void { }

  private accent(text: string) {
    return this.theme.fg?.("accent", text) ?? text;
  }

  private dim(text: string) {
    return this.theme.fg?.("dim", text) ?? text;
  }
}
