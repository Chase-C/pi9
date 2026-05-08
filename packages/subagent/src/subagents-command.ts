import { getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { SettingsList, matchesKey, truncateToWidth, visibleWidth, type Component, type KeybindingsManager, type SettingItem, type TUI } from "@mariozechner/pi-tui";

import type { Agent } from "./agent.js";
import { AgentManager } from "./agent-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import {
  SubagentUiSettingsStore,
  type SubagentUiSettings,
  type WidgetPlacement,
} from "./subagent-settings.js";
import { loadSubagentUiSettings, updateSubagentWidget } from "./subagent-widget.js";
import {
  createSubagentResumeMessage,
  formatAgentConfigInspect,
  formatAgentConfigSummary,
  formatSubagentSessionInspect,
  formatSubagentSessionSummary,
  formatSubagentToolLines,
} from "./format.js";
import {
  canClearSubagentSession,
  canResumeSubagentSession,
  serializeAgent,
} from "./serialize.js";
import type { AgentConfig } from "./agent-config.js";

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" | "success" = "info") {
  if (!ctx.hasUI) return;
  try {
    ctx.ui?.notify?.(message, level as any);
  } catch { }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type SubagentResumeCommandResult = { action: "resume"; sessionId: string; agent: string };
type SubagentsCommandResult = SubagentResumeCommandResult | { action: "settings" };

type SubagentSessionsTheme = {
  fg?: (color: "accent" | "dim", text: string) => string;
  bold?: (text: string) => string;
};

type SubagentKeybindings = Pick<KeybindingsManager, "matches"> | undefined;

class SubagentSettingsComponent implements Component {
  private readonly settingsList: SettingsList;

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

  private readonly theme: SubagentSessionsTheme;

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

class SubagentAgentsComponent implements Component {
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

class SubagentSessionsComponent implements Component {
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
      const detail = session.status.kind === "done" ? session.status.result.status : session.status.kind;
      this.notify(`Subagent session ${session.id} is ${detail} and cannot be resumed.`, "warning");
      return;
    }
    this.done({ action: "resume", sessionId: session.id, agent: session.agentName });
  }

  private clearSelected() {
    const session = this.sessions[this.selected];
    if (!session) return;
    if (!canClearSubagentSession(session)) {
      const detail = session.status.kind === "done" ? session.status.result.status : session.status.kind;
      this.notify(`Subagent session ${session.id} is ${detail} and cannot be cleared.`, "warning");
      return;
    }

    const result = this.agentManager.clear(session.id);
    if (result.cleared > 0) this.notify(`Cleared subagent session ${session.id}.`, "success");
    else this.notify(`Subagent session ${session.id} was already gone.`, "warning");

    const sessions = this.sessions;
    if (sessions.length === 0) {
      this.done();
      return;
    }
    this.selected = clamp(this.selected, 0, sessions.length - 1);
    this.mode = "list";
    this.tui.requestRender();
  }

  private get sessions() {
    return this.agentManager.sessions;
  }

  private accent(text: string) {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }

  private dim(text: string) {
    return this.theme.fg?.("dim", text) ?? text;
  }
}

function fitLinesToWidth(lines: string[], width: number) {
  return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function agentListHelp() {
  return "↑↓ select · enter inspect · s settings · esc close";
}

function agentInspectHelp() {
  return "b back · s settings · esc close";
}

function listHelp(session: Agent | undefined) {
  const actions = ["↑↓ select", "enter inspect"];
  if (session && canResumeSubagentSession(session)) actions.push("r resume");
  actions.push("c clear retained", "esc close");
  return actions.join(" · ");
}

function inspectHelp(session: Agent) {
  const actions = [];
  if (canResumeSubagentSession(session)) actions.push("r resume");
  if (canClearSubagentSession(session)) actions.push("c clear");
  actions.push("b back", "esc close");
  return actions.join(" · ");
}

function keybindingsMatch(keybindings: SubagentKeybindings, data: string, keybinding: "tui.select.cancel" | "tui.select.confirm" | "tui.select.up" | "tui.select.down") {
  try {
    return keybindings?.matches(data, keybinding) ?? false;
  } catch {
    return false;
  }
}

function isEnterKey(data: string, keybindings?: SubagentKeybindings) {
  return keybindingsMatch(keybindings, data, "tui.select.confirm") || matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || data === "\n";
}

function isCancelKey(data: string, keybindings?: SubagentKeybindings) {
  return keybindingsMatch(keybindings, data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "\x1b" || data === "\u0003";
}

function isUpKey(data: string, keybindings?: SubagentKeybindings) {
  return keybindingsMatch(keybindings, data, "tui.select.up") || matchesKey(data, "up") || data === "\x1b[A" || data === "k" || data === "K";
}

function isDownKey(data: string, keybindings?: SubagentKeybindings) {
  return keybindingsMatch(keybindings, data, "tui.select.down") || matchesKey(data, "down") || data === "\x1b[B" || data === "j" || data === "J";
}

async function resumeSessionFromCommand(
  pi: ExtensionAPI,
  agentManager: AgentManager,
  action: SubagentResumeCommandResult,
  ctx: ExtensionCommandContext,
  settingsStore: Pick<SubagentUiSettingsStore, "load">,
) {
  if (!ctx.hasUI || !ctx.ui?.custom || typeof (ctx.ui as any).editor !== "function") {
    notify(ctx, "Resume UI is unavailable for subagent sessions.", "warning");
    return;
  }

  let prompt: unknown;
  try {
    prompt = await (ctx.ui as any).editor(`Resume subagent ${action.agent}`, "");
  } catch (error) {
    notify(ctx, `Subagent resume editor UI failed: ${errorMessage(error)}`, "warning");
    return;
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    notify(ctx, "Subagent resume cancelled: no follow-up prompt provided.", "info");
    return;
  }

  const uiSettings = await loadSubagentUiSettings(ctx, settingsStore);
  let outcome: { result?: unknown; error?: unknown };
  try {
    outcome = await ctx.ui.custom<{ result?: unknown; error?: unknown }>((tui, theme, keybindings, done) => {
      const loader = createResumeLoader(tui, theme, keybindings, `Resuming subagent ${action.agent}...`);
      let settled = false;
      const finish = (value: { result?: unknown; error?: unknown }) => {
        if (settled) return;
        settled = true;
        done(value);
      };

      agentManager.resume(ctx, loader.signal, action.sessionId, prompt, update => {
        updateSubagentWidget(ctx, update.entries.map(e => e.entry), uiSettings);
      }).then(
        result => finish({ result }),
        error => finish({ error }),
      );

      return loader;
    });
  } catch (error) {
    notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
    return;
  }

  const result = normalizeResumeOutcome(action, prompt, outcome);
  updateSubagentWidget(ctx, agentManager.sessions, uiSettings);
  pi.sendMessage?.(createSubagentResumeMessage(result));
  notify(ctx, result.status === "completed"
    ? `Subagent session ${action.sessionId} resumed.`
    : `Subagent session ${action.sessionId} resume ${result.status}.`,
    result.status === "completed" ? "info" : "warning");
}

function createResumeLoader(_tui: TUI, theme: SubagentSessionsTheme, keybindings: SubagentKeybindings, message: string) {
  return new SubagentResumeLoader(theme, keybindings, message);
}

class SubagentResumeLoader implements Component {
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

function normalizeResumeOutcome(action: SubagentResumeCommandResult, prompt: string, outcome: { result?: unknown; error?: unknown }) {
  if (outcome?.result && typeof outcome.result === "object") return outcome.result as {
    agent: string;
    prompt: string;
    status: string;
    output?: string;
    error?: string;
    sessionId?: string;
    resumable?: boolean;
  };

  const error = outcome?.error ? errorMessage(outcome.error) : "Subagent resume failed.";
  return {
    agent: action.agent,
    prompt,
    status: "error",
    error,
    sessionId: action.sessionId,
    resumable: true,
  };
}

async function openSubagentSettings(
  ctx: ExtensionCommandContext,
  agentManager: AgentManager,
  settingsStore: Pick<SubagentUiSettingsStore, "load" | "save">,
) {
  let settings = await loadSubagentUiSettings(ctx, settingsStore);
  if (!ctx.hasUI || !ctx.ui?.custom) {
    notify(ctx, `Subagent widget placement: ${settings.widgetPlacement}`, "info");
    return;
  }

  let saveQueue = Promise.resolve();
  try {
    await ctx.ui.custom<void>((_tui, theme, keybindings, done) => new SubagentSettingsComponent(
      settings,
      theme,
      keybindings,
      placement => {
        settings = { widgetPlacement: placement };
        updateSubagentWidget(ctx, agentManager.sessions, settings);
        const settingsToSave = settings;
        saveQueue = saveQueue.then(() => settingsStore.save(settingsToSave).then(
          () => notify(ctx, `Subagent widget placement set to ${placement}.`, "info"),
          error => notify(ctx, `Failed to save subagent settings: ${errorMessage(error)}`, "warning"),
        ));
      },
      () => done(undefined),
    ));
  } catch (error) {
    notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
  }
  await saveQueue;
}

export function registerSubagentsCommand(
  pi: ExtensionAPI,
  agentManager: AgentManager,
  settingsStore: Pick<SubagentUiSettingsStore, "load" | "save"> = new SubagentUiSettingsStore(),
  agentRegistry?: AgentRegistry,
) {
  pi.registerCommand?.("subagents", {
    description: "Manage active and retained subagent sessions",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim() === "settings") {
        await openSubagentSettings(ctx, agentManager, settingsStore);
        return;
      }

      const sessions = agentManager.sessions;
      if (sessions.length === 0) {
        if (!agentRegistry) {
          notify(ctx, "No active or retained subagent sessions.", "info");
          return;
        }

        await agentRegistry.reload(ctx.cwd);
        const agents = Array.from(agentRegistry.agents.values());
        if (!ctx.hasUI || !ctx.ui?.custom) {
          notify(ctx, agents.length
            ? agents.map(formatAgentConfigSummary).join("\n")
            : "No configured subagent agents.", "info");
          return;
        }

        let action: SubagentsCommandResult | undefined;
        try {
          action = await ctx.ui.custom<SubagentsCommandResult | undefined>((tui, theme, keybindings, done) => {
            return new SubagentAgentsComponent(agents, tui, theme, keybindings, result => done(result));
          });
        } catch (error) {
          notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
          return;
        }
        if (action?.action === "settings") await openSubagentSettings(ctx, agentManager, settingsStore);
        return;
      }

      if (!ctx.hasUI || !ctx.ui?.custom) {
        const serialized = sessions.map(agent => serializeAgent(agent));
        notify(ctx, formatSubagentToolLines({ sessions: serialized }, true).join("\n"), "info");
        return;
      }

      let action: SubagentsCommandResult | undefined;
      try {
        action = await ctx.ui.custom<SubagentsCommandResult | undefined>((tui, theme, keybindings, done) => {
          return new SubagentSessionsComponent(
            agentManager,
            tui,
            theme,
            keybindings,
            (message, level) => notify(ctx, message, level as any),
            result => done(result),
          );
        });
      } catch (error) {
        notify(ctx, `Subagents UI failed: ${errorMessage(error)}`, "warning");
        return;
      }

      if (action?.action === "resume") await resumeSessionFromCommand(pi, agentManager, action, ctx, settingsStore);
    },
  });
}
