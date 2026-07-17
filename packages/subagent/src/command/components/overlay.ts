import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";

import type { SubagentSettings } from "../../config/settings.js";
import type { AgentConfig } from "../../domain/agent-config.js";
import type { AgentSnapshot } from "../../domain/agent-snapshot.js";
import { effectiveStatus } from "../../domain/agent-decisions.js";
import type { AgentManager, SessionConversationMessage } from "../../runtime/agent-manager.js";
import { expandedRunSections, formatUsage, plural, rowElapsed } from "../../view/format-helpers.js";
import { SubagentTextComponent, type DisplayLine, type DisplaySegment } from "../../view/text-component.js";
import { clamp, isCancelKey, isDownKey, isEnterKey, isUpKey, type SubagentKeybindings } from "../input.js";
import { filterAgents, projectSessions, type SessionLayoutMode, type SessionRow } from "../overlay-view-model.js";
import { SubagentSettingsComponent, type SubagentSettingsChange } from "./settings.js";

export type SubagentOverlayPage = "sessions" | "agents" | "settings";

type FocusRegion = "list" | "filter" | "composer" | "agentPrompt";

const DEFAULT_BROWSER_HEIGHT = 24;
const OVERLAY_HEIGHT_RATIO = 0.8;
const OVERLAY_CHROME_HEIGHT = 4;

export interface SubagentOverlayOptions {
  readonly initialPage: SubagentOverlayPage;
  readonly agents: readonly AgentConfig[];
  readonly settings: SubagentSettings;
  readonly onSettingsChange: (change: SubagentSettingsChange) => SubagentSettings | void;
  readonly onResume: (sessionId: string, prompt: string) => void;
  readonly onStart: (agent: string, prompt: string) => string | undefined;
  readonly notify: (message: string, level?: string) => void;
}

const PAGES: SubagentOverlayPage[] = ["agents", "sessions", "settings"];
const PAGE_LABELS: Record<SubagentOverlayPage, string> = {
  sessions: "Sessions",
  agents: "Agents",
  settings: "Settings",
};

export class SubagentOverlayComponent implements Component, Focusable {
  private _focused = false;
  private page: SubagentOverlayPage;
  private focusRegion: FocusRegion = "list";
  private sessionMode: SessionLayoutMode = "flat";
  private readonly selected: Record<SubagentOverlayPage, number> = { sessions: 0, agents: 0, settings: 0 };
  private readonly filters = { sessions: new Input(), agents: new Input() };
  private readonly composer = new Input();
  private readonly agentPrompt = new Input();
  private conversationSession?: AgentSnapshot;
  private conversationMessages: readonly SessionConversationMessage[] = [];
  private conversationPending: readonly string[] = [];
  private agentPromptName?: string;
  private readonly unsubscribe?: () => void;
  private readonly settingsComponent: SubagentSettingsComponent;
  private actionError = "";
  private currentSettings: SubagentSettings;
  private readonly browserHeight: number;

  constructor(
    private readonly manager: AgentManager,
    private readonly tui: Pick<TUI, "requestRender"> & { terminal?: Pick<TUI["terminal"], "rows"> },
    private readonly theme: Theme,
    private readonly keybindings: SubagentKeybindings,
    private readonly done: () => void,
    private readonly options: SubagentOverlayOptions,
  ) {
    this.page = options.initialPage;
    this.currentSettings = options.settings;
    this.browserHeight = tui.terminal
      ? Math.max(8, Math.floor(tui.terminal.rows * OVERLAY_HEIGHT_RATIO) - OVERLAY_CHROME_HEIGHT)
      : DEFAULT_BROWSER_HEIGHT;
    this.settingsComponent = new SubagentSettingsComponent(
      options.settings,
      theme,
      keybindings,
      change => {
        const updated = options.onSettingsChange(change);
        if (updated) this.currentSettings = updated;
      },
      () => { this.page = "sessions"; this.requestRender(); },
      () => this.requestRender(),
    );
    this.filters.sessions.onEscape = () => this.setFocus("list");
    this.filters.agents.onEscape = () => this.setFocus("list");
    this.filters.sessions.onSubmit = () => this.setFocus("list");
    this.filters.agents.onSubmit = () => this.setFocus("list");
    this.composer.onEscape = () => this.closeConversation();
    this.composer.onSubmit = value => this.submitComposer(value);
    this.agentPrompt.onEscape = () => this.setFocus("list");
    this.agentPrompt.onSubmit = value => this.submitAgentPrompt(value);
    this.unsubscribe = typeof (manager as any).onAgentUpdate === "function"
      ? manager.onAgentUpdate(() => {
          this.refreshConversation();
          this.requestRender();
        })
      : undefined;
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  invalidate(): void {
    this.filters.sessions.invalidate();
    this.filters.agents.invalidate();
    this.composer.invalidate();
    this.agentPrompt.invalidate();
    this.settingsComponent.invalidate();
  }

  dispose(): void { this.unsubscribe?.(); }

  handleInput(data: string): void {
    if (this.focusRegion === "filter") {
      const input = this.activeFilter;
      if (!input) return;
      const before = input.getValue();
      input.handleInput(data);
      if (before !== input.getValue()) {
        this.selected[this.page] = 0;
        if (this.page === "agents") this.clearAgentPrompt();
      }
      this.requestRender();
      return;
    }
    if (this.focusRegion === "composer") {
      this.composer.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.focusRegion === "agentPrompt") {
      this.agentPrompt.handleInput(data);
      this.requestRender();
      return;
    }
    if (isCancelKey(data, this.keybindings)) {
      this.done();
      return;
    }
    if (matchesKey(data, "tab") || data === "\t") {
      this.switchPage(1);
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.switchPage(-1);
      return;
    }
    if ((this.page === "sessions" || this.page === "agents") && data === "/") {
      this.setFocus("filter");
      return;
    }
    if (this.page === "settings") {
      this.settingsComponent.handleInput(data);
      return;
    }
    if (isUpKey(data, this.keybindings)) {
      this.moveSelection(-1);
      return;
    }
    if (isDownKey(data, this.keybindings)) {
      this.moveSelection(1);
      return;
    }
    if (this.page === "sessions") this.handleSessionsInput(data);
    else if (this.page === "agents") this.handleAgentsInput(data);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    lines.push(`${this.border("╭")}${this.conversationSession ? this.renderConversationTitle(innerWidth) : this.renderTabs(innerWidth)}${this.border("╮")}`);

    const body = this.conversationSession
      ? this.renderConversation(innerWidth)
      : this.page === "settings"
        ? fitBodyHeight([
            "",
            ...this.settingsComponent.render(Math.max(1, innerWidth - 1)).map(line => ` ${line}`),
          ], this.browserHeight)
        : this.renderBrowser(innerWidth);
    for (const line of body) lines.push(this.row(line, innerWidth));

    lines.push(this.border(`├${"─".repeat(innerWidth)}┤`));
    lines.push(this.row(this.theme.fg?.("dim", this.helpText()) ?? this.helpText(), innerWidth));
    lines.push(this.border(`╰${"─".repeat(innerWidth)}╯`));
    return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width, "") : line);
  }

  private renderTabs(width: number): string {
    const tabs = PAGES.map(page => {
      const label = `[ ${PAGE_LABELS[page]} ]`;
      return page === this.page
        ? this.theme.fg?.("accent", this.theme.bold?.(label) ?? label) ?? label
        : label;
    }).join(this.border("──"));
    const leadingWidth = Math.min(3, width);
    const fitted = truncateToWidth(tabs, width - leadingWidth, "");
    const remaining = Math.max(0, width - leadingWidth - visibleWidth(fitted));
    return `${this.border("─".repeat(leadingWidth))}${fitted}${this.border("─".repeat(remaining))}`;
  }

  private renderConversationTitle(width: number): string {
    const session = this.conversationSession!;
    const status = statusLabel(session);
    const title = ` ${session.config.name} · ${session.id} · ${status} `;
    const fitted = truncateToWidth(title, width, "");
    return `${this.border("─")}${this.theme.fg?.("accent", this.theme.bold?.(fitted) ?? fitted) ?? fitted}${this.border("─".repeat(Math.max(0, width - visibleWidth(fitted) - 1)))}`;
  }

  private renderConversation(width: number): string[] {
    this.refreshConversation();
    const contentWidth = Math.max(1, width - 2);
    const transcript: string[] = [];
    for (const message of this.conversationMessages) {
      if (message.role === "user") {
        transcript.push(...new Markdown(message.text, 1, 0, markdownTheme(this.theme), {
          color: text => this.theme.fg?.("userMessageText", text) ?? text,
          bgColor: text => this.theme.bg?.("userMessageBg", text) ?? text,
        }).render(contentWidth), "");
      } else if (message.role === "assistant") {
        transcript.push(...new Markdown(message.text, 0, 0, markdownTheme(this.theme)).render(contentWidth), "");
      } else {
        const glyph = message.isError ? "✗" : message.role === "tool" ? "●" : "└";
        const color: ThemeColor = message.isError ? "error" : message.role === "tool" ? "toolTitle" : "toolOutput";
        transcript.push(...new Text(this.theme.fg?.(color, `${glyph} ${message.text}`) ?? `${glyph} ${message.text}`, 0, 0).render(contentWidth));
      }
    }
    for (const pending of this.conversationPending) {
      transcript.push(...new Markdown(pending, 1, 0, markdownTheme(this.theme), {
        color: text => this.theme.fg?.("userMessageText", text) ?? text,
        bgColor: text => this.theme.bg?.("userMessageBg", text) ?? text,
      }).render(contentWidth));
      transcript.push(this.theme.fg?.("dim", "queued") ?? "queued", "");
    }
    if (transcript.length === 0) {
      transcript.push(this.theme.fg?.("dim", "Conversation is starting…") ?? "Conversation is starting…");
    }
    const session = this.conversationSession!;
    if (session.status.kind === "done" && session.status.output && !this.conversationMessages.some(message => message.role === "assistant")) {
      transcript.push(...new Markdown(session.status.output, 0, 0, markdownTheme(this.theme)).render(contentWidth));
    }
    const input = this.composer.render(contentWidth);
    const inputHeight = Math.max(1, input.length);
    const transcriptHeight = Math.max(1, this.browserHeight - inputHeight - 2);
    const visibleTranscript = transcript.slice(-transcriptHeight);
    const body = [
      ...fitBodyHeight(visibleTranscript, transcriptHeight).map(line => ` ${line}`),
      this.border("─".repeat(width)),
      ...input.map(line => ` ${line}`),
    ];
    if (this.actionError) body.splice(-inputHeight, 0, truncateWithColor(this.theme, "error", ` ${this.actionError}`, width));
    return fitBodyHeight(body, this.browserHeight);
  }

  private renderFilter(width: number): string {
    const input = this.activeFilter!;
    const suffix = this.page === "sessions" ? `  View: ${this.sessionMode === "flat" ? "[Flat] Tree" : "Flat [Tree]"}` : "";
    const available = Math.max(8, width - visibleWidth(suffix) - 12);
    const rendered = input.render(available)[0] ?? "";
    const placeholder = input.getValue() || this.focusRegion === "filter" ? rendered : this.theme.fg?.("dim", "Filter…") ?? "Filter…";
    return ` / ${placeholder}${suffix}`;
  }

  private renderBrowser(width: number): string[] {
    const leftWidth = width >= 80 ? Math.max(30, Math.floor(width * 0.4)) : width;
    const rightWidth = width >= 80 ? width - leftWidth - 1 : width;
    const leftContentWidth = Math.max(1, leftWidth - 1);
    const rightContentWidth = Math.max(1, rightWidth - 1);
    const left = this.renderList(leftContentWidth, width < 80);
    const hasFilter = this.page === "sessions" || this.page === "agents";
    if (width < 80) {
      const divider = this.theme.fg?.("borderMuted", "─".repeat(width)) ?? "─".repeat(width);
      const available = Math.max(4, this.browserHeight - 1 - (hasFilter ? 1 : 0));
      const listHeight = Math.floor(available / 2);
      const inspectorHeight = available - listHeight;
      const list = fitBodyHeight(left, Math.max(1, listHeight - 1));
      const inspectorContentHeight = Math.max(1, inspectorHeight - 1);
      const right = this.renderInspector(rightContentWidth, inspectorContentHeight);
      const inspector = fitBodyHeight(compactViewport(right, inspectorContentHeight, Math.min(4, inspectorContentHeight - 1)), inspectorContentHeight);
      return [
        "",
        ...list.map(line => ` ${line}`),
        ...(hasFilter ? [` ${this.renderFilter(Math.max(1, width - 1))}`] : []),
        divider,
        "",
        ...inspector.map(line => ` ${line}`),
      ];
    }
    const visibleLeft = left;
    const inspectorHeight = Math.max(1, this.browserHeight - 1);
    const right = this.renderInspector(rightContentWidth, inspectorHeight);
    const visibleRight = compactViewport(right, inspectorHeight, 5);
    const lines: string[] = [];
    for (let index = 0; index < this.browserHeight; index++) {
      const leftLine = index === 0
        ? ""
        : hasFilter && index === this.browserHeight - 1
          ? this.renderFilter(leftContentWidth)
          : visibleLeft[index - 1] ?? "";
      const rightLine = index === 0 ? "" : visibleRight[index - 1] ?? "";
      lines.push(`${pad(` ${leftLine}`, leftWidth)} ${pad(` ${rightLine}`, rightWidth)}`);
    }
    return lines;
  }

  private renderList(width: number, narrow: boolean): string[] {
    if (this.page === "sessions") return this.renderSessionList(this.sessionRows, width, narrow);
    return this.renderAgentList(this.filteredAgents, width, narrow);
  }

  private renderSessionList(rows: readonly SessionRow[], width: number, narrow: boolean): string[] {
    if (rows.length === 0) return [this.theme.fg?.("dim", " No matching sessions.") ?? " No sessions."];
    this.selected[this.page] = clamp(this.selected[this.page], 0, rows.length - 1);
    const { start, end } = listViewport(rows.length, this.selected[this.page], this.listLineBudget(narrow));
    const lines: string[] = [];
    for (let index = start; index < end; index++) {
      const row = rows[index];
      const session = row.session;
      const chosen = index === this.selected[this.page];
      const indent = "  ".repeat(row.depth);
      const marker = chosen ? this.theme.fg?.("accent", "┃ ") ?? "┃ " : "  ";
      const status = statusLabel(session);
      const agentName = this.theme.bold?.(session.config.name) ?? session.config.name;
      const sessionId = this.theme.fg?.("accent", session.id) ?? session.id;
      const title = `${marker}${indent}${statusIcon(session)} ${agentName} ${sessionId}${session.label ? `  ${session.label}` : ""}`;
      const task = session.prompt || session.config.description || "No task description";
      const meta = `${status} · ${session.activity.turns} turns · ${session.activity.toolHistory.length} tools · ${session.attempt.dispatch}`;
      lines.push(chosen
        ? truncateWithColor(this.theme, "accent", title, width)
        : truncateToWidth(title, width, "…"));
      lines.push(row.contextOnly
        ? truncateWithColor(this.theme, "dim", `    ${indent}(ancestor context)`, width)
        : truncateToWidth(`    ${indent}${compact(task)}`, width, "…"));
      lines.push(truncateWithColor(this.theme, "dim", `    ${indent}${meta}`, width));
      lines.push("");
    }
    return lines;
  }

  private renderAgentList(agents: readonly AgentConfig[], width: number, narrow: boolean): string[] {
    if (agents.length === 0) return [this.theme.fg?.("dim", " No matching agent definitions.") ?? " No matching agent definitions."];
    this.selected.agents = clamp(this.selected.agents, 0, agents.length - 1);
    const { start, end } = listViewport(agents.length, this.selected.agents, this.listLineBudget(narrow));
    return agents.slice(start, end).flatMap((agent, offset) => {
      const index = start + offset;
      const chosen = index === this.selected.agents;
      const marker = chosen ? this.theme.fg?.("accent", "┃ ") ?? "┃ " : "  ";
      const name = this.theme.bold?.(agent.name) ?? agent.name;
      const location = this.theme.fg?.("muted", `[${agent.source}]`) ?? `[${agent.source}]`;
      const modelThinkingText = `${agent.model ?? "default"}:${agent.thinking ?? "default"}`;
      const modelThinking = this.theme.fg?.("dim", modelThinkingText) ?? modelThinkingText;
      const identity = `${marker}${name} · ${modelThinking}`;
      const identityWidth = Math.max(1, width - visibleWidth(location) - 1);
      const fittedIdentity = truncateToWidth(identity, identityWidth, "…");
      const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedIdentity) - visibleWidth(location)));
      const title = `${fittedIdentity}${gap}${location}`;
      const description = truncateToWidth(`    ${compact(agent.description)}`, width, "…");
      const metadata = [
        agent.tools?.length ? plural(agent.tools.length, "tool") : "default tools",
        plural(agent.skills?.length ?? 0, "skill"),
        ...(agent.retainConversation ? ["retained"] : []),
      ].join(" · ");
      return [
        chosen ? truncateWithColor(this.theme, "accent", title, width) : truncateToWidth(title, width, "…"),
        description,
        truncateWithColor(this.theme, "dim", `    ${metadata}`, width),
        "",
      ];
    });
  }

  private renderInspector(width: number, height: number): string[] {
    if (this.page === "agents") {
      const agent = this.filteredAgents[this.selected.agents];
      if (!agent) return [];
      return this.renderAgentInspector(agent, width, height);
    }
    const session = this.sessionRows[this.selected.sessions]?.session;
    if (!session) return [];
    return this.renderSessionInspector(session, width, Date.now());
  }

  private renderAgentInspector(agent: AgentConfig, width: number, height: number): string[] {
    const promptLine = this.agentPrompt.getValue() || this.focusRegion === "agentPrompt"
      ? this.agentPrompt.render(Math.max(8, width))[0] ?? ""
      : `> ${this.theme.fg?.("dim", "Describe the task") ?? "Describe the task"}`;
    const beforeInstructions = [
      ...this.inspectorSection(this.theme.bold?.(agent.name) ?? agent.name, [agent.description], width, "accent"),
      ...this.inspectorSection("Configuration", [
        `Source: ${agent.source}`,
        `Model: ${agent.model ?? "default"} · thinking:${agent.thinking ?? "default"}`,
        `Retain conversation: ${agent.retainConversation}`,
        `Tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}`,
        `Skills: ${agent.skills?.length ? agent.skills.join(", ") : "none"}`,
        ...(agent.sourcePath ? [`Path: ${agent.sourcePath}`] : []),
      ], width),
    ];
    const footer = [
      "",
      this.heading("Start Subagent"),
      promptLine,
      this.theme.fg?.("dim", "Enter/s start") ?? "Enter/s start",
      ...(this.actionError ? [truncateWithColor(this.theme, "error", ` ${this.actionError}`, width)] : []),
    ];
    const instructionHeight = Math.max(0, height - beforeInstructions.length - footer.length - 1);
    const instructions = renderInstructionSection(agent.systemPrompt ?? "", width, instructionHeight, this.theme);
    return [...beforeInstructions, ...instructions, ...footer];
  }

  private renderSessionInspector(session: AgentSnapshot, width: number, now: number): string[] {
    const sections = expandedRunSections(session, true, this.currentSettings.display, now, true);
    const task = unindentDisplayLines(sections.task, 4);
    const details = unindentDisplayLines(sections.details, 4);
    const sessionMetadata = [
      ...(session.label ? [`Label: ${session.label}`] : []),
      `Status: ${effectiveStatus(session.status)}${session.conversation.policy === "retain" ? " · retained" : ""}${session.capabilities.canResume ? " · resumable" : ""}`,
      ...(session.config.source ? [`Source: ${session.config.source}`] : []),
      `Attempt: ${session.attempt.kind} · dispatch:${session.attempt.dispatch}`,
      ...(session.config.model || session.config.thinking
        ? [`Model: ${session.config.model ?? "default"} · thinking:${session.config.thinking ?? "default"}`]
        : []),
    ];
    const activity = [
      `Progress: ${plural(session.activity.turns, "turn")} · ${plural(session.activity.toolHistory.length, "tool use")} · ${plural(session.activity.compactions, "compaction")}`,
      ...(session.usage ? [`Usage: ${formatUsage(session.usage)}`] : []),
      `Elapsed: ${rowElapsed(session, now)}`,
    ];
    const agentName = this.theme.bold?.(session.config.name) ?? session.config.name;
    const displayLines: DisplayLine[] = [
      ...displaySection(`${agentName} · ${session.id}`, sessionMetadata, "accent"),
      ...task,
      ...displaySection("Activity", activity),
      ...details,
      { text: `Actions: inspect${session.status.kind === "running" || session.capabilities.canResume ? " · conversation" : ""}${session.capabilities.canRemove ? " · remove" : ""}`, color: "muted" },
    ];
    return new SubagentTextComponent(displayLines, this.theme).render(width);
  }

  private inspectorSection(
    label: string,
    values: readonly string[],
    width: number,
    labelColor: ThemeColor = "muted",
  ): string[] {
    return new SubagentTextComponent(displaySection(label, values, labelColor), this.theme).render(width);
  }

  private handleSessionsInput(data: string): void {
    const row = this.sessionRows[this.selected.sessions];
    if ((data === "t" || data === "T")) {
      this.sessionMode = this.sessionMode === "flat" ? "tree" : "flat";
      this.selected.sessions = 0;
      this.requestRender();
    } else if (isEnterKey(data, this.keybindings) && row && (row.session.status.kind === "running" || row.session.capabilities.canResume)) {
      this.openConversation(row.session);
    } else if ((data === "x" || data === "X") && row && isActive(row.session)) {
      void this.manager.stopSession(row.session.id).catch(error => this.options.notify(errorMessage(error), "warning"));
      this.requestRender();
    } else if ((data === "c" || data === "C") && row?.session.capabilities.canRemove) {
      void this.manager.remove({ sessionIds: [row.session.id] }).then(
        result => this.options.notify(result.removed > 0 ? `Removed subagent session ${row.session.id}.` : `Subagent session ${row.session.id} was already gone.`, result.removed > 0 ? "success" : "warning"),
        error => this.options.notify(errorMessage(error), "warning"),
      );
      this.requestRender();
    }
  }

  private handleAgentsInput(data: string): void {
    const agent = this.filteredAgents[this.selected.agents];
    if (!agent) return;
    if (data === "s" || data === "S" || isEnterKey(data, this.keybindings)) this.focusAgentPrompt(agent.name);
  }

  private submitAgentPrompt(value: string): void {
    const agent = this.filteredAgents[this.selected.agents];
    const prompt = value.trim();
    if (!agent || agent.name !== this.agentPromptName) {
      this.clearAgentPrompt();
      this.setFocus("list");
      return;
    }
    if (!prompt) return;

    this.clearAgentPrompt();
    this.actionError = "";
    try {
      this.options.onStart(agent.name, prompt);
    } catch (error) {
      this.actionError = errorMessage(error);
      this.options.notify(`Failed to start ${agent.name}: ${this.actionError}`, "warning");
    }
    this.setFocus("list");
  }

  private submitComposer(value: string): void {
    const session = this.conversationSession;
    const text = value.trim();
    if (!session || !text) return;
    this.composer.setValue("");
    this.actionError = "";
    if (session.status.kind === "running") {
      void this.manager.steerSession(session.id, text).then(
        () => {
          this.refreshConversation();
          this.requestRender();
        },
        error => {
          this.actionError = errorMessage(error);
          this.options.notify(`Failed to message ${session.id}: ${this.actionError}`, "warning");
          this.requestRender();
        },
      );
    } else if (session.capabilities.canResume) {
      try {
        this.options.onResume(session.id, text);
      } catch (error) {
        this.actionError = errorMessage(error);
        this.options.notify(`Failed to resume ${session.id}: ${this.actionError}`, "warning");
      }
    }
    this.setFocus("composer");
  }

  private moveSelection(delta: number): void {
    const count = this.page === "sessions" ? this.sessionRows.length
      : this.page === "agents" ? this.filteredAgents.length
      : 0;
    const previous = this.selected[this.page];
    this.selected[this.page] = clamp(previous + delta, 0, Math.max(0, count - 1));
    if (this.page === "agents" && this.selected.agents !== previous) this.clearAgentPrompt();
    this.requestRender();
  }

  private switchPage(delta: number): void {
    const index = PAGES.indexOf(this.page);
    this.page = PAGES[(index + delta + PAGES.length) % PAGES.length];
    this.setFocus("list");
  }

  private focusAgentPrompt(agentName: string): void {
    if (this.agentPromptName !== agentName) this.agentPrompt.setValue("");
    this.agentPromptName = agentName;
    this.setFocus("agentPrompt");
  }

  private clearAgentPrompt(): void {
    this.agentPrompt.setValue("");
    this.agentPromptName = undefined;
  }

  private openConversation(session: AgentSnapshot): void {
    this.conversationSession = session;
    this.conversationMessages = [];
    this.conversationPending = [];
    this.composer.setValue("");
    this.actionError = "";
    this.refreshConversation();
    this.setFocus("composer");
  }

  private closeConversation(): void {
    this.conversationSession = undefined;
    this.conversationMessages = [];
    this.conversationPending = [];
    this.composer.setValue("");
    this.actionError = "";
    this.setFocus("list");
  }

  private refreshConversation(): void {
    const id = this.conversationSession?.id;
    if (!id) return;
    const listed = this.manager.listSessions().find(session => session.id === id);
    if (listed) this.conversationSession = listed;
    try {
      const detail = this.manager.sessionConversation(id);
      this.conversationSession = detail.session;
      if (detail.messages.length > 0) this.conversationMessages = detail.messages;
      this.conversationPending = [...detail.pending.steering, ...detail.pending.followUp];
    } catch {
      // Keep the last projected snapshot and transcript if a transient session just settled.
    }
  }

  private setFocus(region: FocusRegion): void {
    this.focusRegion = region;
    this.syncInputFocus();
    this.requestRender();
  }

  private syncInputFocus(): void {
    this.filters.sessions.focused = this._focused && this.focusRegion === "filter" && this.page === "sessions";
    this.filters.agents.focused = this._focused && this.focusRegion === "filter" && this.page === "agents";
    this.composer.focused = this._focused && this.focusRegion === "composer" && this.conversationSession !== undefined;
    this.agentPrompt.focused = this._focused && this.focusRegion === "agentPrompt" && this.page === "agents";
  }

  private requestRender(): void { this.tui.requestRender(); }

  private get activeFilter(): Input | undefined {
    return this.page === "sessions" ? this.filters.sessions : this.page === "agents" ? this.filters.agents : undefined;
  }

  private get sessionRows(): SessionRow[] {
    return projectSessions(this.manager.listSessions(), {
      mode: this.sessionMode,
      query: this.filters.sessions.getValue(),
    });
  }

  private get filteredAgents(): AgentConfig[] {
    return filterAgents(this.options.agents, this.filters.agents.getValue());
  }

  private listLineBudget(narrow: boolean): number {
    const hasFilter = this.page === "sessions" || this.page === "agents";
    if (!narrow) return Math.max(1, this.browserHeight - 1 - (hasFilter ? 1 : 0));
    const available = Math.max(4, this.browserHeight - 1 - (hasFilter ? 1 : 0));
    return Math.max(1, Math.floor(available / 2) - 1);
  }

  private heading(text: string): string {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }

  private border(text: string): string { return this.theme.fg?.("border", text) ?? text; }

  private row(content: string, width: number): string {
    return `${this.border("│")}${pad(content, width)}${this.border("│")}`;
  }

  private helpText(): string {
    if (this.conversationSession) return "enter send · esc back to sessions";
    if (this.page === "sessions") return "↑↓ select · enter conversation · / filter · t flat/tree · x stop · c remove · tab pages · esc close";
    if (this.page === "agents") return "↑↓ select · / filter · enter/s start · tab pages · esc close";
    return "↑↓ select · enter change · tab pages · esc close";
  }
}

function markdownTheme(theme: Theme): MarkdownTheme {
  const color = (name: ThemeColor) => (text: string) => theme.fg?.(name, text) ?? text;
  return {
    heading: color("mdHeading"),
    link: color("mdLink"),
    linkUrl: color("mdLinkUrl"),
    code: color("mdCode"),
    codeBlock: color("mdCodeBlock"),
    codeBlockBorder: color("mdCodeBlockBorder"),
    quote: color("mdQuote"),
    quoteBorder: color("mdQuoteBorder"),
    hr: color("mdHr"),
    listBullet: color("mdListBullet"),
    bold: text => theme.bold?.(text) ?? text,
    italic: text => theme.italic?.(text) ?? text,
    strikethrough: text => theme.strikethrough?.(text) ?? text,
    underline: text => text,
  };
}

function pad(text: string, width: number): string {
  const fitted = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function truncateWithColor(theme: Theme, color: ThemeColor, text: string, width: number): string {
  if (!theme.fg) return truncateToWidth(text, width, "…");
  return truncateToWidth(theme.fg(color, text), width, theme.fg(color, "…"));
}

function compact(text: string): string { return text.replace(/\s+/g, " ").trim(); }

function renderInstructionSection(
  systemPrompt: string,
  width: number,
  maxHeight: number,
  theme: Theme,
): string[] {
  if (maxHeight < 3) return [];
  const contentWidth = Math.max(1, width - 2);
  const wrapped = (systemPrompt.trim() || "No agent instructions.")
    .split(/\r?\n/)
    .flatMap(line => line ? wrapTextWithAnsi(line, contentWidth) : [""]);
  const bodyHeight = maxHeight - 2;
  const truncated = wrapped.length > bodyHeight;
  const muted = (text: string) => theme.fg?.("muted", text) ?? text;
  let visible: string[];
  if (truncated && bodyHeight === 1) {
    const remainder = muted(`… ${wrapped.length - 1} more lines`);
    visible = [truncateToWidth(`${wrapped[0]} ${remainder}`, contentWidth, "…")];
  } else {
    visible = truncated ? wrapped.slice(0, Math.max(0, bodyHeight - 1)) : wrapped;
    if (truncated) visible.push(muted(`… ${wrapped.length - visible.length} more lines`));
  }
  const rail = muted;
  return [
    rail("┌ Instructions"),
    ...visible.map(line => `${rail("│")} ${line}`),
    rail("└"),
  ];
}

function displaySection(label: string, values: readonly string[], labelColor: ThemeColor = "muted"): DisplayLine[] {
  const continuationPrefix = [
    { text: "│", color: "muted" as const },
    { text: " " },
  ];
  return [
    {
      text: `┌ ${label}`,
      segments: [
        { text: "┌", color: "muted" },
        { text: " " },
        { text: label, color: labelColor },
      ],
    },
    ...values.map(value => ({
      text: `│ ${value}`,
      hangingIndent: 2,
      segments: [...continuationPrefix, { text: value, color: "text" as const }],
      continuationPrefix,
    })),
    { text: "└", color: "muted" },
  ];

}

function unindentDisplayLines(lines: DisplayLine[], amount: number): DisplayLine[] {
  const spaces = " ".repeat(amount);
  return lines.map(line => ({
    ...line,
    text: line.text.startsWith(spaces) ? line.text.slice(amount) : line.text,
    ...(line.hangingIndent !== undefined ? { hangingIndent: Math.max(0, line.hangingIndent - amount) } : {}),
    ...(line.segments ? { segments: unindentSegments(line.segments, amount) } : {}),
    ...(line.continuationPrefix ? { continuationPrefix: unindentSegments(line.continuationPrefix, amount) } : {}),
  }));
}

function unindentSegments(segments: readonly DisplaySegment[], amount: number): DisplaySegment[] {
  let remaining = amount;
  const result: DisplaySegment[] = [];
  for (const segment of segments) {
    if (remaining === 0) {
      result.push(segment);
      continue;
    }
    const leading = segment.text.match(/^ */)?.[0].length ?? 0;
    const remove = Math.min(leading, remaining);
    remaining -= remove;
    const text = segment.text.slice(remove);
    if (text) result.push({ ...segment, text });
    if (remove < leading || leading < segment.text.length) remaining = 0;
  }
  return result;
}

function fitBodyHeight(lines: string[], height: number): string[] {
  return [...lines.slice(0, height), ...Array(Math.max(0, height - lines.length)).fill("")];
}

function compactViewport(lines: string[], size: number, tail: number): string[] {
  if (lines.length <= size) return lines;
  const tailCount = Math.min(tail, size - 1);
  const headCount = size - tailCount - 1;
  return [...lines.slice(0, headCount), `… ${lines.length - headCount - tailCount} more`, ...lines.slice(-tailCount)];
}

function listViewport(count: number, selected: number, lineBudget: number): { start: number; end: number } {
  const size = Math.max(1, Math.floor(lineBudget / 4));
  const start = clamp(selected - Math.floor(size / 2), 0, Math.max(0, count - size));
  return { start, end: Math.min(count, start + size) };
}

function isActive(session: AgentSnapshot): boolean {
  return session.status.kind === "queued" || session.status.kind === "running";
}

function statusIcon(session: AgentSnapshot): string {
  if (session.status.kind === "running") return "●";
  if (session.status.kind === "queued") return "○";
  return session.status.outcome === "completed" ? "✓" : "✗";
}

function statusLabel(session: AgentSnapshot): string {
  return session.status.kind === "done" ? session.status.outcome : session.status.kind;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
