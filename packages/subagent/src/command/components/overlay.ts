import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

import type { SubagentSettings } from "../../config/settings.js";
import type { AgentConfig } from "../../domain/agent-config.js";
import type { AgentSnapshot } from "../../domain/agent-snapshot.js";
import type { AgentManager } from "../../runtime/agent-manager.js";
import { formatAgentConfigInspect, formatSubagentSessionInspect } from "../../view/format.js";
import { rowElapsed } from "../../view/format-helpers.js";
import { clamp, isCancelKey, isDownKey, isEnterKey, isUpKey, type SubagentKeybindings } from "../input.js";
import { filterAgents, projectSessions, type SessionLayoutMode, type SessionRow } from "../overlay-view-model.js";
import { SubagentSettingsComponent, type SubagentSettingsChange } from "./settings.js";

export type SubagentOverlayPage = "sessions" | "agents" | "attached" | "settings";

type FocusRegion = "list" | "filter" | "composer";

export interface SubagentOverlayOptions {
  readonly initialPage: SubagentOverlayPage;
  readonly agents: readonly AgentConfig[];
  readonly settings: SubagentSettings;
  readonly onSettingsChange: (change: SubagentSettingsChange) => SubagentSettings | void;
  readonly onResume: (sessionId: string, prompt: string) => void;
  readonly notify: (message: string, level?: string) => void;
}

const PAGES: SubagentOverlayPage[] = ["sessions", "agents", "attached", "settings"];
const PAGE_LABELS: Record<SubagentOverlayPage, string> = {
  sessions: "Sessions",
  agents: "Agents",
  attached: "Attached",
  settings: "Settings",
};

export class SubagentOverlayComponent implements Component, Focusable {
  private _focused = false;
  private page: SubagentOverlayPage;
  private focusRegion: FocusRegion = "list";
  private sessionMode: SessionLayoutMode = "flat";
  private readonly selected: Record<SubagentOverlayPage, number> = { sessions: 0, agents: 0, attached: 0, settings: 0 };
  private readonly filters = { sessions: new Input(), agents: new Input() };
  private readonly composer = new Input();
  private readonly unsubscribe?: () => void;
  private readonly settingsComponent: SubagentSettingsComponent;
  private actionError = "";
  private currentSettings: SubagentSettings;

  constructor(
    private readonly manager: AgentManager,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
    private readonly keybindings: SubagentKeybindings,
    private readonly done: () => void,
    private readonly options: SubagentOverlayOptions,
  ) {
    this.page = options.initialPage;
    this.currentSettings = options.settings;
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
    this.composer.onEscape = () => this.setFocus("list");
    this.composer.onSubmit = value => this.submitComposer(value);
    this.unsubscribe = typeof (manager as any).onAgentUpdate === "function"
      ? manager.onAgentUpdate(() => this.requestRender())
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
    this.settingsComponent.invalidate();
  }

  dispose(): void { this.unsubscribe?.(); }

  handleInput(data: string): void {
    if (this.focusRegion === "filter") {
      const input = this.activeFilter;
      if (!input) return;
      const before = input.getValue();
      input.handleInput(data);
      if (before !== input.getValue()) this.selected[this.page] = 0;
      this.requestRender();
      return;
    }
    if (this.focusRegion === "composer") {
      this.composer.handleInput(data);
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
    else if (this.page === "attached") this.handleAttachedInput(data);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    lines.push(this.border(`╭${titleRule(" Subagents ", innerWidth)}╮`));
    lines.push(this.row(this.renderTabs(), innerWidth));
    if (this.page === "sessions" || this.page === "agents") lines.push(this.row(this.renderFilter(innerWidth), innerWidth));
    lines.push(this.border(`├${"─".repeat(innerWidth)}┤`));

    const body = this.page === "settings" ? this.settingsComponent.render(innerWidth - 2) : this.renderBrowser(innerWidth);
    for (const line of body) lines.push(this.row(line, innerWidth));

    lines.push(this.border(`├${"─".repeat(innerWidth)}┤`));
    lines.push(this.row(this.theme.fg?.("dim", this.helpText()) ?? this.helpText(), innerWidth));
    lines.push(this.border(`╰${"─".repeat(innerWidth)}╯`));
    return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width, "") : line);
  }

  private renderTabs(): string {
    return ` ${PAGES.map(page => page === this.page
      ? this.theme.fg?.("accent", this.theme.bold?.(`[ ${PAGE_LABELS[page]} ]`) ?? `[ ${PAGE_LABELS[page]} ]`) ?? `[ ${PAGE_LABELS[page]} ]`
      : `  ${PAGE_LABELS[page]}  `).join(" ")}`;
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
    const leftWidth = width >= 80 ? Math.max(30, Math.floor(width * 0.42)) : width;
    const rightWidth = width >= 80 ? width - leftWidth - 1 : width;
    const left = this.renderList(leftWidth);
    const right = this.renderInspector(rightWidth);
    if (width < 80) {
      const divider = this.theme.fg?.("borderMuted", "─".repeat(width)) ?? "─".repeat(width);
      return [...compactViewport(left, 5, 1), divider, ...compactViewport(right, 6, 3)];
    }
    const height = 12;
    const visibleLeft = compactViewport(left, height, 1);
    const visibleRight = compactViewport(right, height, 4);
    const lines: string[] = [];
    for (let index = 0; index < height; index++) {
      lines.push(`${pad(visibleLeft[index] ?? "", leftWidth)}${this.border("│")}${pad(visibleRight[index] ?? "", rightWidth)}`);
    }
    return lines;
  }

  private renderList(width: number): string[] {
    if (this.page === "sessions") return this.renderSessionList(this.sessionRows, width);
    if (this.page === "agents") return this.renderAgentList(this.filteredAgents, width);
    return this.renderSessionList(this.attachedRows, width);
  }

  private renderSessionList(rows: readonly SessionRow[], width: number): string[] {
    if (rows.length === 0) return [this.theme.fg?.("dim", this.page === "attached" ? " No attached sessions." : " No matching sessions.") ?? " No sessions."];
    this.selected[this.page] = clamp(this.selected[this.page], 0, rows.length - 1);
    const start = viewportStart(this.selected[this.page], rows.length, 4);
    const lines: string[] = [];
    for (let index = start; index < Math.min(rows.length, start + 4); index++) {
      const row = rows[index];
      const session = row.session;
      const chosen = index === this.selected[this.page];
      const indent = "  ".repeat(row.depth);
      const marker = chosen ? "▶" : " ";
      const status = statusLabel(session);
      const title = `${marker} ${indent}${statusIcon(session)} ${session.config.name}${session.label ? `  ${session.label}` : ""}`;
      const task = session.prompt || session.config.description || "No task description";
      const meta = `${status} · ${session.activity.turns} turns · ${session.activity.toolHistory.length} tools · ${session.dispatch}`;
      const style = chosen ? (text: string) => this.theme.fg?.("accent", text) ?? text : (text: string) => text;
      lines.push(style(truncateToWidth(title, width, "…")));
      lines.push(row.contextOnly
        ? this.theme.fg?.("dim", truncateToWidth(`    ${indent}(ancestor context)`, width, "…")) ?? `    ${indent}(ancestor context)`
        : truncateToWidth(`    ${indent}${compact(task)}`, width, "…"));
      lines.push(this.theme.fg?.("dim", truncateToWidth(`    ${indent}${meta}`, width, "…")) ?? meta);
    }
    return lines;
  }

  private renderAgentList(agents: readonly AgentConfig[], width: number): string[] {
    if (agents.length === 0) return [this.theme.fg?.("dim", " No matching agent definitions.") ?? " No matching agent definitions."];
    this.selected.agents = clamp(this.selected.agents, 0, agents.length - 1);
    const start = viewportStart(this.selected.agents, agents.length, 6);
    return agents.slice(start, start + 6).flatMap((agent, offset) => {
      const index = start + offset;
      const chosen = index === this.selected.agents;
      const title = `${chosen ? "▶" : " "} ${agent.name}  ${agent.source}${agent.model ? ` · ${agent.model}` : ""}${agent.resumable ? " · resumable" : ""}`;
      const description = `   ${agent.description}`;
      return [
        chosen ? this.theme.fg?.("accent", truncateToWidth(title, width, "…")) ?? title : truncateToWidth(title, width, "…"),
        this.theme.fg?.("dim", truncateToWidth(description, width, "…")) ?? description,
      ];
    });
  }

  private renderInspector(width: number): string[] {
    if (this.page === "agents") {
      const agent = this.filteredAgents[this.selected.agents];
      return agent ? [this.heading(" Agent Definition"), ...formatAgentConfigInspect(agent).flatMap(line => wrapLine(` ${line}`, width))] : [];
    }
    const rows = this.page === "attached" ? this.attachedRows : this.sessionRows;
    const session = rows[this.selected[this.page]]?.session;
    if (!session) return [];
    const lines = [this.heading(this.page === "attached" ? " Attached Session" : " Subagent Session")];
    const now = Date.now();
    const inspectLines = formatSubagentSessionInspect(session, now, this.currentSettings.display)
      .map(line => line.startsWith("Timestamps:") ? `Elapsed: ${rowElapsed(session, now)}` : line);
    lines.push(...inspectLines.flatMap(line => wrapLine(` ${line}`, width)));
    if (this.page === "attached") {
      lines.push("", this.heading(session.status.kind === "running" ? " Live Conversation" : " Conversation"));
      try {
        const detail = this.manager.attachedSessionDetail(session.id);
        for (const message of detail.messages.slice(-8)) {
          const label = message.role === "tool" || message.role === "toolResult"
            ? `${message.isError ? "✗" : "›"} ${message.toolName ?? "tool"}`
            : message.role === "user" ? "You" : session.config.name;
          lines.push(this.theme.fg?.("muted", ` ${label}`) ?? ` ${label}`);
          if (message.role !== "tool" || message.text !== message.toolName) {
            lines.push(...wrapLine(`   ${compact(message.text)}`, width));
          }
        }
        const pending = [...detail.pending.steering, ...detail.pending.followUp];
        if (pending.length) lines.push(this.theme.fg?.("dim", ` ${pending.length} queued message${pending.length === 1 ? "" : "s"}`) ?? ` ${pending.length} queued messages`);
      } catch {
        for (const tool of session.activity.toolHistory.slice(-4)) {
          lines.push(truncateToWidth(` ${tool.completedAt ? "✓" : "●"} ${tool.name}`, width, "…"));
        }
      }
      if (session.status.kind === "done" && session.status.output) lines.push(...wrapLine(` ${session.status.output}`, width));
      const prompt = session.status.kind === "running" ? "Send steering message" : session.capabilities.canResume ? "Resume this session" : "Input unavailable";
      const inputLine = this.composer.getValue() || this.focusRegion === "composer"
        ? this.composer.render(Math.max(8, width - 3))[0] ?? ""
        : this.theme.fg?.("dim", prompt) ?? prompt;
      lines.push(` > ${inputLine}`);
      if (this.actionError) lines.push(this.theme.fg?.("error", truncateToWidth(` ${this.actionError}`, width, "…")) ?? this.actionError);
    }
    return lines;
  }

  private handleSessionsInput(data: string): void {
    const row = this.sessionRows[this.selected.sessions];
    if ((data === "t" || data === "T")) {
      this.sessionMode = this.sessionMode === "flat" ? "tree" : "flat";
      this.selected.sessions = 0;
      this.requestRender();
    } else if ((data === "a" || data === "A") && row) {
      try {
        this.manager.attachToSession(row.session.id);
        this.page = "attached";
        this.selected.attached = Math.max(0, this.attachedRows.findIndex(item => item.session.id === row.session.id));
        this.actionError = "";
      } catch (error) {
        this.actionError = errorMessage(error);
        this.options.notify(this.actionError, "warning");
      }
      this.requestRender();
    } else if ((data === "x" || data === "X") && row?.session.status.kind === "running") {
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

  private handleAttachedInput(data: string): void {
    const row = this.attachedRows[this.selected.attached];
    if ((data === "x" || data === "X") && row?.session.status.kind === "running") {
      void this.manager.stopSession(row.session.id).catch(error => this.options.notify(errorMessage(error), "warning"));
      this.requestRender();
    } else if ((data === "d" || data === "D") && row) {
      this.manager.detachFromSession(row.session.id);
      this.selected.attached = clamp(this.selected.attached, 0, Math.max(0, this.attachedRows.length - 1));
      this.actionError = "";
      this.requestRender();
    } else if ((data === "s" || data === "S" || isEnterKey(data, this.keybindings)) && row) {
      if (row.session.status.kind === "running" || row.session.capabilities.canResume) this.setFocus("composer");
    }
  }

  private submitComposer(value: string): void {
    const session = this.attachedRows[this.selected.attached]?.session;
    const text = value.trim();
    if (!session || !text) return;
    this.composer.setValue("");
    this.actionError = "";
    if (session.status.kind === "running") {
      void this.manager.steerSession(session.id, text).catch(error => {
        this.actionError = errorMessage(error);
        this.options.notify(`Failed to steer ${session.id}: ${this.actionError}`, "warning");
        this.requestRender();
      });
    } else if (session.capabilities.canResume) {
      try {
        this.options.onResume(session.id, text);
      } catch (error) {
        this.actionError = errorMessage(error);
        this.options.notify(`Failed to resume ${session.id}: ${this.actionError}`, "warning");
      }
    }
    this.setFocus("list");
  }

  private moveSelection(delta: number): void {
    const count = this.page === "sessions" ? this.sessionRows.length
      : this.page === "agents" ? this.filteredAgents.length
      : this.attachedRows.length;
    this.selected[this.page] = clamp(this.selected[this.page] + delta, 0, Math.max(0, count - 1));
    this.requestRender();
  }

  private switchPage(delta: number): void {
    const index = PAGES.indexOf(this.page);
    this.page = PAGES[(index + delta + PAGES.length) % PAGES.length];
    this.setFocus("list");
  }

  private setFocus(region: FocusRegion): void {
    this.focusRegion = region;
    this.syncInputFocus();
    this.requestRender();
  }

  private syncInputFocus(): void {
    this.filters.sessions.focused = this._focused && this.focusRegion === "filter" && this.page === "sessions";
    this.filters.agents.focused = this._focused && this.focusRegion === "filter" && this.page === "agents";
    this.composer.focused = this._focused && this.focusRegion === "composer" && this.page === "attached";
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

  private get attachedRows(): SessionRow[] {
    const sessions = typeof (this.manager as any).listAttachedSessions === "function" ? this.manager.listAttachedSessions() : [];
    return sessions.map(session => ({ session, depth: 0 }));
  }

  private get filteredAgents(): AgentConfig[] {
    return filterAgents(this.options.agents, this.filters.agents.getValue());
  }

  private heading(text: string): string {
    return this.theme.fg?.("accent", this.theme.bold?.(text) ?? text) ?? text;
  }

  private border(text: string): string { return this.theme.fg?.("border", text) ?? text; }

  private row(content: string, width: number): string {
    return `${this.border("│")}${pad(content, width)}${this.border("│")}`;
  }

  private helpText(): string {
    if (this.page === "sessions") return "↑↓ select · / filter · t flat/tree · a attach · x stop · c remove · tab pages · esc close";
    if (this.page === "agents") return "↑↓ select · / filter · tab pages · esc close";
    if (this.page === "attached") return "↑↓ select · enter/s message · x stop · d detach · tab pages · esc close";
    return "↑↓ select · enter change · tab pages · esc close";
  }
}

function pad(text: string, width: number): string {
  const fitted = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function titleRule(title: string, width: number): string {
  const fitted = truncateToWidth(title, width, "");
  return `${fitted}${"─".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function wrapLine(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width)).map(line => truncateToWidth(line, width, ""));
}

function compact(text: string): string { return text.replace(/\s+/g, " ").trim(); }

function compactViewport(lines: string[], size: number, tail: number): string[] {
  if (lines.length <= size) return lines;
  const tailCount = Math.min(tail, size - 1);
  const headCount = size - tailCount - 1;
  return [...lines.slice(0, headCount), `… ${lines.length - headCount - tailCount} more`, ...lines.slice(-tailCount)];
}

function viewportStart(selected: number, count: number, size: number): number {
  return clamp(selected - Math.floor(size / 2), 0, Math.max(0, count - size));
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
