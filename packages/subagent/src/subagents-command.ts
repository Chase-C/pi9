import { getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { SettingsList, type Component, type SettingItem, type TUI } from "@mariozechner/pi-tui";

import { AgentManager } from "./agent-manager.js";
import {
  SubagentUiSettingsStore,
  type SubagentUiSettings,
  type WidgetPlacement,
} from "./subagent-settings.js";
import { loadSubagentUiSettings, updateSubagentWidget } from "./subagent-widget.js";
import {
  canClearSubagentSession,
  canResumeSubagentSession,
  createSubagentResumeMessage,
  formatSubagentSessionInspect,
  formatSubagentSessionSummary,
  formatSubagentToolLines,
  type SubagentSessionDto,
} from "./subagent-ui.js";

function listManagedSessions(agentManager: AgentManager): SubagentSessionDto[] {
  const maybeManager = agentManager as AgentManager & { sessions?: SubagentSessionDto[]; listSessions?: () => SubagentSessionDto[] };
  return maybeManager.listSessions?.() ?? maybeManager.sessions ?? [];
}

type SubagentsCommandResult = { action: "resume"; sessionId: string; agent: string };

type SubagentSessionsTheme = {
  fg?: (color: "accent" | "dim", text: string) => string;
  bold?: (text: string) => string;
};

class SubagentSettingsComponent implements Component {
  private readonly settingsList: SettingsList;

  constructor(
    settings: SubagentUiSettings,
    theme: SubagentSessionsTheme,
    onChange: (placement: WidgetPlacement) => void,
    done: () => void,
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
    return [this.accent("Subagent Settings"), "", ...this.settingsList.render(width)];
  }

  handleInput(data: string): void { this.settingsList.handleInput(data); }

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

class SubagentSessionsComponent implements Component {
  private selected = 0;
  private mode: "list" | "inspect" = "list";

  constructor(
    private readonly agentManager: AgentManager,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: SubagentSessionsTheme,
    private readonly notify: (message: string, level?: string) => void,
    private readonly done: (result?: SubagentsCommandResult) => void,
  ) { }

  invalidate(): void { }

  render(_width: number): string[] {
    const sessions = this.sessions;
    if (sessions.length === 0) return [this.accent("Subagent Sessions"), "No active or retained subagent sessions."];

    this.selected = clamp(this.selected, 0, sessions.length - 1);
    if (this.mode === "inspect") {
      const session = sessions[this.selected];
      return [
        this.accent("Subagent Session"),
        ...formatSubagentSessionInspect(session).map(line => `  ${line}`),
        this.dim(inspectHelp(session)),
      ];
    }

    return [
      this.accent("Subagent Sessions"),
      ...sessions.map((session, index) => {
        const prefix = index === this.selected ? "> " : "  ";
        const line = `${prefix}${formatSubagentSessionSummary(session)}`;
        return index === this.selected ? this.accent(line) : line;
      }),
      this.dim(listHelp(sessions[this.selected])),
    ];
  }

  handleInput(data: string): void {
    const sessions = this.sessions;
    if (isCancelKey(data)) {
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
    if (isEnterKey(data) && sessions.length > 0) {
      this.mode = "inspect";
      this.tui.requestRender();
      return;
    }
    if (this.mode === "list" && isUpKey(data)) {
      this.selected = clamp(this.selected - 1, 0, Math.max(0, sessions.length - 1));
      this.tui.requestRender();
      return;
    }
    if (this.mode === "list" && isDownKey(data)) {
      this.selected = clamp(this.selected + 1, 0, Math.max(0, sessions.length - 1));
      this.tui.requestRender();
    }
  }

  private resumeSelected() {
    const session = this.sessions[this.selected];
    if (!session) return;
    if (!canResumeSubagentSession(session)) {
      this.notify(`Subagent session ${session.sessionId} is ${session.status} and cannot be resumed.`, "warning");
      return;
    }
    this.done({ action: "resume", sessionId: session.sessionId, agent: session.agent });
  }

  private clearSelected() {
    const session = this.sessions[this.selected];
    if (!session) return;
    if (!canClearSubagentSession(session)) {
      this.notify(`Subagent session ${session.sessionId} is ${session.status} and cannot be cleared.`, "warning");
      return;
    }

    const result = this.agentManager.clear(session.sessionId);
    if (result.cleared > 0) this.notify(`Cleared subagent session ${session.sessionId}.`, "success");
    else this.notify(`Subagent session ${session.sessionId} was already gone.`, "warning");

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
    return listManagedSessions(this.agentManager);
  }

  private accent(text: string) {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }

  private dim(text: string) {
    return this.theme.fg?.("dim", text) ?? text;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function listHelp(session: SubagentSessionDto | undefined) {
  const actions = ["↑↓ select", "enter inspect"];
  if (session && canResumeSubagentSession(session)) actions.push("r resume");
  actions.push("c clear retained", "esc close");
  return actions.join(" · ");
}

function inspectHelp(session: SubagentSessionDto) {
  const actions = [];
  if (canResumeSubagentSession(session)) actions.push("r resume");
  if (canClearSubagentSession(session)) actions.push("c clear");
  actions.push("b back", "esc close");
  return actions.join(" · ");
}

function isEnterKey(data: string) {
  return data === "\r" || data === "\n";
}

function isCancelKey(data: string) {
  return data === "\x1b" || data === "\u0003";
}

function isUpKey(data: string) {
  return data === "\x1b[A" || data === "k" || data === "K";
}

function isDownKey(data: string) {
  return data === "\x1b[B" || data === "j" || data === "J";
}

async function resumeSessionFromCommand(
  pi: ExtensionAPI,
  agentManager: AgentManager,
  action: SubagentsCommandResult,
  ctx: ExtensionCommandContext,
  settingsStore: Pick<SubagentUiSettingsStore, "load">,
) {
  const prompt = await ctx.ui.editor(`Resume subagent ${action.agent}`, "");
  if (typeof prompt !== "string" || prompt.trim() === "") {
    ctx.ui.notify("Subagent resume cancelled: no follow-up prompt provided.", "info");
    return;
  }

  const uiSettings = await loadSubagentUiSettings(ctx, settingsStore);
  const outcome = await ctx.ui.custom<{ result?: unknown; error?: unknown }>((tui, theme, _keybindings, done) => {
    const loader = createResumeLoader(tui, theme, `Resuming subagent ${action.agent}...`);
    let settled = false;
    const finish = (value: { result?: unknown; error?: unknown }) => {
      if (settled) return;
      settled = true;
      done(value);
    };

    agentManager.resume(ctx, loader.signal, action.sessionId, prompt, update => {
      updateSubagentWidget(ctx, update.sessions, uiSettings);
    }).then(
      result => finish({ result }),
      error => finish({ error }),
    );

    return loader;
  });

  const result = normalizeResumeOutcome(action, prompt, outcome);
  updateSubagentWidget(ctx, listManagedSessions(agentManager), uiSettings);
  pi.sendMessage?.(createSubagentResumeMessage(result));
  ctx.ui.notify(result.status === "completed"
    ? `Subagent session ${action.sessionId} resumed.`
    : `Subagent session ${action.sessionId} resume ${result.status}.`,
    result.status === "completed" ? "info" : "warning");
}

function createResumeLoader(_tui: TUI, theme: SubagentSessionsTheme, message: string) {
  return new SubagentResumeLoader(theme, message);
}

class SubagentResumeLoader implements Component {
  private readonly controller = new AbortController();

  constructor(private readonly theme: SubagentSessionsTheme, private readonly message: string) { }

  get signal() { return this.controller.signal; }

  invalidate(): void { }

  render() { return [this.accent(this.message), this.dim("esc cancel")]; }

  handleInput(data: string) {
    if (isCancelKey(data)) this.controller.abort();
  }

  dispose(): void { }

  private accent(text: string) {
    return this.theme.fg?.("accent", text) ?? text;
  }

  private dim(text: string) {
    return this.theme.fg?.("dim", text) ?? text;
  }
}

function normalizeResumeOutcome(action: SubagentsCommandResult, prompt: string, outcome: { result?: unknown; error?: unknown }) {
  if (outcome?.result && typeof outcome.result === "object") return outcome.result as {
    agent: string;
    prompt: string;
    status: string;
    output?: string;
    error?: string;
    sessionId?: string;
    resumable?: boolean;
  };

  const error = outcome?.error instanceof Error ? outcome.error.message : String(outcome?.error ?? "Subagent resume failed.");
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
    ctx.ui.notify(`Subagent widget placement: ${settings.widgetPlacement}`, "info");
    return;
  }

  let saveQueue = Promise.resolve();
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new SubagentSettingsComponent(
    settings,
    theme,
    placement => {
      settings = { widgetPlacement: placement };
      updateSubagentWidget(ctx, listManagedSessions(agentManager), settings);
      const settingsToSave = settings;
      saveQueue = saveQueue.then(() => settingsStore.save(settingsToSave).then(
        () => ctx.ui.notify(`Subagent widget placement set to ${placement}.`, "info"),
        error => ctx.ui.notify(`Failed to save subagent settings: ${error instanceof Error ? error.message : String(error)}`, "warning"),
      ));
    },
    () => done(undefined),
  ));
  await saveQueue;
}

export function registerSubagentsCommand(
  pi: ExtensionAPI,
  agentManager: AgentManager,
  settingsStore: Pick<SubagentUiSettingsStore, "load" | "save"> = new SubagentUiSettingsStore(),
) {
  (pi as ExtensionAPI & { registerCommand?: ExtensionAPI["registerCommand"] }).registerCommand?.("subagents", {
    description: "Manage active and retained subagent sessions",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim() === "settings") {
        await openSubagentSettings(ctx, agentManager, settingsStore);
        return;
      }

      const sessions = listManagedSessions(agentManager);
      if (sessions.length === 0) {
        ctx.ui.notify("No active or retained subagent sessions.", "info");
        return;
      }

      if (!ctx.hasUI || !ctx.ui?.custom) {
        ctx.ui.notify(formatSubagentToolLines({ sessions }, true).join("\n"), "info");
        return;
      }

      const action = await ctx.ui.custom<SubagentsCommandResult | undefined>((tui, theme, _keybindings, done) => {
        return new SubagentSessionsComponent(
          agentManager,
          tui,
          theme,
          (message, level) => ctx.ui.notify(message, level as any),
          result => done(result),
        );
      });

      if (action?.action === "resume") await resumeSessionFromCommand(pi, agentManager, action, ctx, settingsStore);
    },
  });
}
