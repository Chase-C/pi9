import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Markdown,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentConfig } from "../agents.js";
import { effectiveStatus, type ConversationSnapshot, type RunSnapshot } from "../conversation.js";
import type { SubagentRuntime } from "../runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "../settings.js";
import { clamp, isCancelKey, isDownKey, isEnterKey, isShiftTabKey, isUpKey, type SubagentKeybindings } from "./input.js";
import { filterAgents, projectConversations, type ConversationLayoutMode } from "./overlay-model.js";
import { SubagentSettingsComponent, type SubagentSettingsChange } from "./settings.js";

export type SubagentOverlayPage = "conversations" | "agents" | "settings";
type FocusRegion = "list" | "filter" | "prompt";
type PromptTarget = { kind: "agent"; name: string } | { kind: "resume"; conversationId: string };

const PAGES: SubagentOverlayPage[] = ["agents", "conversations", "settings"];
const PAGE_LABELS: Record<SubagentOverlayPage, string> = { agents: "Agents", conversations: "Conversations", settings: "Settings" };
const DEFAULT_BODY_HEIGHT = 24;
const OVERLAY_CHROME_HEIGHT = 6;

export interface OverlayOptions {
  initialPage: SubagentOverlayPage;
  agents: readonly AgentConfig[];
  settings: SubagentSettings;
  notify(message: string, level?: string): void;
  onSettingsChange(change: SubagentSettingsChange): SubagentSettings | void;
  onStart(agent: string, prompt: string): string | undefined;
  onResume(conversationId: string, prompt: string): void;
  onRemove?(conversationId: string): void;
}

export class SubagentOverlayComponent implements Component, Focusable {
  private _focused = false;
  private page: SubagentOverlayPage;
  private focusRegion: FocusRegion = "list";
  private conversationMode: ConversationLayoutMode = "tree";
  private readonly selected: Record<SubagentOverlayPage, number> = { conversations: 0, agents: 0, settings: 0 };
  private selectedConversationId?: string;
  private selectedAgentName?: string;
  private readonly filters = { conversations: new Input(), agents: new Input() };
  private readonly prompt = new Input();
  private promptTarget?: PromptTarget;
  private detail?: { conversationId: string; runId?: string };
  private actionError = "";
  private readonly settings: SubagentSettingsComponent;
  private readonly unsubscribe: () => void;
  private readonly bodyHeight: number;

  constructor(
    private readonly manager: SubagentRuntime,
    private readonly tui: Pick<TUI, "requestRender"> & { terminal?: Pick<TUI["terminal"], "rows"> },
    private readonly theme: Theme,
    private readonly keybindings: SubagentKeybindings,
    private readonly done: () => void,
    private readonly options: OverlayOptions,
  ) {
    this.page = options.initialPage;
    this.bodyHeight = tui.terminal ? Math.max(1, Math.floor(tui.terminal.rows * 0.8) - OVERLAY_CHROME_HEIGHT) : DEFAULT_BODY_HEIGHT;
    const settings = options.settings?.runtime && options.settings?.display ? options.settings : DEFAULT_SUBAGENT_SETTINGS;
    this.settings = new SubagentSettingsComponent(
      settings,
      theme,
      keybindings,
      change => options.onSettingsChange(change),
      () => { this.page = "conversations"; this.requestRender(); },
      () => this.requestRender(),
    );
    for (const input of Object.values(this.filters)) {
      input.onEscape = () => this.setFocus("list");
      input.onSubmit = () => this.setFocus("list");
    }
    this.prompt.onEscape = () => this.closePrompt();
    this.prompt.onSubmit = value => this.submitPrompt(value);
    this.unsubscribe = manager.onConversationUpdate(() => this.requestRender());
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.syncFocus(); }

  handleInput(data: string): void {
    if (this.focusRegion === "filter") {
      const input = this.activeFilter;
      if (!input) return;
      const before = input.getValue();
      input.handleInput(data);
      if (before !== input.getValue()) this.resetSelection();
      this.requestRender();
      return;
    }
    if (this.focusRegion === "prompt") {
      this.prompt.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.detail) {
      if (isCancelKey(data, this.keybindings)) this.detail = undefined;
      else if (data.toLowerCase() === "r") this.openResumePrompt(this.detail.conversationId);
      else if (data.toLowerCase() === "x" || data.toLowerCase() === "c") this.removeConversation(this.detail.conversationId);
      this.requestRender();
      return;
    }
    if (isCancelKey(data, this.keybindings) || data === "q") { this.done(); return; }
    if (data === "\t") { this.switchPage(1); return; }
    if (isShiftTabKey(data)) { this.switchPage(-1); return; }
    if ((this.page === "conversations" || this.page === "agents") && data === "/") { this.setFocus("filter"); return; }
    if (this.page === "settings") { this.settings.handleInput(data); return; }
    if (isUpKey(data, this.keybindings)) { this.moveSelection(-1); return; }
    if (isDownKey(data, this.keybindings)) { this.moveSelection(1); return; }
    if (this.page === "agents") this.handleAgentAction(data);
    else this.handleConversationAction(data);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const header = this.detail ? this.renderDetailTitle(innerWidth) : this.renderTabs(innerWidth);
    const body = this.detail
      ? this.renderDetail(innerWidth)
      : this.page === "settings"
        ? fitHeight(this.settings.render(Math.max(1, innerWidth - 2)), this.bodyHeight)
        : this.renderBrowser(innerWidth);
    const lines = [
      this.border(`╭${"─".repeat(innerWidth)}╮`),
      this.row(header, innerWidth),
      this.border(`├${"─".repeat(innerWidth)}┤`),
      ...body.map(line => this.row(line, innerWidth)),
      this.border(`├${"─".repeat(innerWidth)}┤`),
      this.row(this.muted(this.helpText()), innerWidth),
      this.border(`╰${"─".repeat(innerWidth)}╯`),
    ];
    return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width, "") : line);
  }

  invalidate(): void {
    this.filters.conversations.invalidate();
    this.filters.agents.invalidate();
    this.prompt.invalidate();
    this.settings.invalidate();
  }

  dispose(): void { this.unsubscribe(); }

  private renderTabs(width: number): string {
    const tabs = PAGES.map(page => {
      const label = `[ ${PAGE_LABELS[page]} ]`;
      return page === this.page ? this.accent(label) : label;
    }).join("  ");
    const title = this.accent("Subagents");
    const spacious = ` ${title}    ${tabs}`;
    const compact = `${title}  ${tabs}`;
    if (visibleWidth(spacious) <= width) return spacious;
    if (visibleWidth(compact) <= width) return compact;
    return truncateToWidth(` ${tabs}`, width, "");
  }

  private renderDetailTitle(width: number): string {
    const conversation = this.findConversation(this.detail!.conversationId);
    const run = conversation && this.findRun(conversation, this.detail!.runId);
    const title = conversation ? `${conversation.config.name} · ${conversation.conversationId}${run ? ` · ${run.runId}` : ""}` : "Conversation unavailable";
    return truncateToWidth(` ${this.accent("Subagents")}  ${title}`, width, "");
  }

  private renderBrowser(width: number): string[] {
    const wide = width >= 80;
    const leftWidth = wide ? Math.max(30, Math.floor(width * 0.36)) : width;
    const rightWidth = wide ? width - leftWidth - 3 : width;
    const list = this.renderList(Math.max(1, leftWidth - 2));
    const inspector = this.renderInspector(Math.max(1, rightWidth - 2));
    const filter = this.renderFilter(Math.max(1, leftWidth - 2));

    if (!wide) {
      if (this.bodyHeight < 4) {
        const listHeight = Math.max(0, this.bodyHeight - 1);
        return [
          ...fitHeight(this.renderListViewport(list, listHeight, Math.max(1, leftWidth - 2)), listHeight),
          ` ${filter}`,
        ];
      }
      const contentHeight = this.bodyHeight - 2;
      const listHeight = Math.ceil(contentHeight / 2);
      const inspectorHeight = contentHeight - listHeight;
      return [
        ...fitHeight(this.renderListViewport(list, listHeight, Math.max(1, leftWidth - 2)), listHeight),
        ` ${filter}`,
        this.border("─".repeat(width)),
        ...fitHeight(compactViewport(inspector, inspectorHeight), inspectorHeight),
      ];
    }

    const topPadding = this.bodyHeight > 1 ? 1 : 0;
    const listHeight = Math.max(0, this.bodyHeight - topPadding - 1);
    const left = [...(topPadding ? [""] : []), ...fitHeight(this.renderListViewport(list, listHeight, Math.max(1, leftWidth - 2)), listHeight), filter];
    const right = fitHeight([...(topPadding ? [""] : []), ...compactViewport(inspector, Math.max(0, this.bodyHeight - topPadding))], this.bodyHeight);
    return left.map((line, index) => `${pad(` ${line}`, leftWidth)} ${this.border("│")} ${pad(` ${right[index] ?? ""}`, rightWidth)}`);
  }

  private renderListViewport(list: string[], height: number, width: number): string[] {
    if (list.length <= height || height < 6) return viewportAt(list, height, this.selectedListLine);

    const itemCount = this.page === "agents" ? this.filteredAgents.length : this.conversationRows.length;
    const selected = this.page === "agents" ? this.selectedAgent() : this.selectedConversation();
    const visibleCount = Math.max(1, Math.floor((height - 2) / 4));
    const start = clamp(selected - Math.floor(visibleCount / 2), 0, Math.max(0, itemCount - visibleCount));
    const end = Math.min(itemCount, start + visibleCount);
    const above = start;
    const below = itemCount - end;
    return [
      above ? this.muted(center(`▲ ${above} more above`, width)) : "",
      ...list.slice(start * 4, end * 4),
      below ? this.muted(center(`▼ ${below} more below`, width)) : "",
    ];
  }

  private renderList(width: number): string[] {
    if (this.page === "agents") {
      const agents = this.filteredAgents;
      if (!agents.length) return [this.muted("No matching agent definitions.")];
      const selected = this.selectedAgent(agents);
      return agents.flatMap((agent, index) => {
        const isSelected = index === selected;
        const marker = isSelected ? this.accent("┃ ") : "  ";
        const name = isSelected ? this.accent(agent.name) : agent.name;
        return [
          truncateToWidth(`${marker}${name} ${this.muted(`· ${agent.source}`)}`, width, "…"),
          truncateToWidth(`${marker}${compact(agent.description)}`, width, "…"),
          `${marker}${this.muted(truncateToWidth(`${agent.model ?? "default"}:${agent.thinking ?? "default"} · ${count(agent.tools, "tool")}${agent.skills?.length ? ` · ${count(agent.skills, "skill")}` : ""}`, Math.max(1, width - 2), "…"))}`,
          "",
        ];
      });
    }

    const rows = this.conversationRows;
    if (!rows.length) return [this.muted("No matching conversations.")];
    const selected = this.selectedConversation(rows);
    return rows.flatMap((row, index) => {
      const conversation = row.conversation;
      const run = conversation.currentRun ?? conversation.runs.at(-1);
      const isSelected = index === selected;
      const firstPrefix = `${isSelected ? this.accent("┃ ") : "  "}${this.muted(row.treePrefix ?? "")}`;
      const continuationPrefix = `${isSelected ? this.accent("┃ ") : "  "}${this.muted(row.treeContinuation ?? "")}`;
      const identity = conversation.label || conversation.config.name;
      const name = isSelected ? this.accent(identity) : identity;
      const agent = conversation.label ? ` · ${conversation.config.name}` : "";
      const config = requestedConfigLabel(conversation);
      const title = `${name}${this.muted(`${agent}${config ? ` (${config})` : ""}`)}`;
      const status = run ? effectiveStatus(run.status) : "idle";
      const elapsed = run ? formatElapsed(runElapsedMs(run)) : "0ms";
      const tokens = run ? formatTokens(run.usage.totalTokens) : "0 tokens";
      const timeline = run ? runRecency(run) : "idle";
      const activity = `${run?.activity.turns ?? 0} ${plural(run?.activity.turns ?? 0, "turn")} · ${run?.activity.toolHistory.length ?? 0} ${plural(run?.activity.toolHistory.length ?? 0, "tool")}`;
      return [
        truncateToWidth(`${firstPrefix}${title}`, width, "…"),
        truncateToWidth(`${continuationPrefix}${run ? this.statusText(run, status) : this.muted(status)} ${this.muted(`· ${elapsed} · ${tokens}`)}`, width, "…"),
        truncateToWidth(`${continuationPrefix}${this.muted(`${row.contextOnly ? "ancestor context · " : ""}${timeline} · ${activity} · ${conversation.conversationId}`)}`, width, "…"),
        row.treeContinuation ? `  ${this.muted(row.treeContinuation)}` : "",
      ];
    });
  }

  private renderInspector(width: number): string[] {
    if (this.page === "agents") {
      const agents = this.filteredAgents;
      const agent = agents[this.selectedAgent(agents)];
      return agent ? this.renderAgentInspector(agent, width) : [];
    }

    const rows = this.conversationRows;
    const conversation = rows[this.selectedConversation(rows)]?.conversation;
    if (!conversation) return [];
    const latest = conversation.currentRun ?? conversation.runs.at(-1);
    return latest ? this.renderConversationChronology(conversation, latest, width) : [];
  }

  private renderAgentInspector(agent: AgentConfig, width: number): string[] {
    const lines = [
      `${this.accent(agent.name)} ${this.muted(`· ${agent.source}`)}`,
      "",
      ...wrapParagraphs(agent.description || "No description.", width),
      "",
      `${this.tag("model", agent.model ?? "default")} ${this.muted("·")} ${this.tag("thinking", agent.thinking ?? "default")}`,
      `${this.tag("tools", agent.tools?.join(", ") || "default")} ${this.muted("·")} ${this.tag("skills", agent.skills?.join(", ") || "none")}`,
      ...(agent.sourcePath ? [this.tag("source", agent.sourcePath)] : []),
      "",
      ...wrapParagraphs(agent.systemPrompt.trim() || "No custom instructions.", width),
    ];
    const action = this.promptTarget?.kind === "agent"
      ? [`${this.success("→")} ${this.accent(`Start ${agent.name}`)}`, ...this.renderPrompt(width), ...(this.actionError ? [this.error(this.actionError)] : [])]
      : [`${this.success("→")} ${this.accent(`Start ${agent.name}`)} ${this.muted("· enter to compose a task")}`];
    return pinBottom(lines, action, Math.max(1, this.bodyHeight - 1));
  }

  private renderConversationChronology(conversation: ConversationSnapshot, run: RunSnapshot, width: number): string[] {
    const runIndex = conversation.runs.findIndex(candidate => candidate.runId === run.runId);
    const previousRuns = conversation.runs.slice(0, Math.max(0, runIndex));
    const status = effectiveStatus(run.status);
    const lines = [
      `${this.accent(conversation.label || conversation.config.name)} ${this.muted(`· ${conversation.config.name} · ${status}`)}`,
      "",
      `${this.tag("conversation", conversation.conversationId)} ${this.muted("·")} ${this.tag("run", run.runId)}`,
      `${this.tag("model", conversation.effectiveConfig?.model ?? conversation.config.model ?? "default")} ${this.muted("·")} ${this.tag("thinking", conversation.effectiveConfig?.thinking ?? conversation.config.thinking ?? "default")}`,
      ...(conversation.effectiveConfig ? [this.tag("cwd", conversation.effectiveConfig.cwd)] : []),
      "",
    ];

    if (previousRuns.length) {
      lines.push(`${this.muted("◆")} ${this.accent("Previous runs")}`);
      for (const previous of previousRuns) {
        const label = conversation.label || compact(previous.prompt);
        const failure = previous.status.kind === "done" && previous.status.outcome !== "completed"
          ? ` ${this.statusText(previous, `[${previous.status.outcome}]`)}`
          : "";
        const summary = `${label}${failure} ${this.muted(`· ${previous.runId} · ${activitySummary(previous)} · ${formatTokens(previous.usage.totalTokens)}`)}`;
        lines.push(`  ${truncateToWidth(summary, Math.max(1, width - 2), "…")}`);
      }
      lines.push(this.muted("│"));
    }

    lines.push(
      `${this.muted("◆")} ${this.accent("Current prompt")}`,
      ...wrapTextWithAnsi(run.prompt, Math.max(1, width - 2)).map(line => `  ${line}`),
      this.muted("│"),
      `${this.statusAccent(run, "●")} ${this.accent("Activity")}`,
      `  ${this.muted(`${activitySummary(run)} · ${formatElapsed(runElapsedMs(run))} · ${formatTokens(run.usage.totalTokens)}`)}`,
    );
    if (run.status.kind !== "done" && run.activity.messageSnippet) {
      lines.push(`  ${this.dim(truncateToWidth(compact(run.activity.messageSnippet), Math.max(1, width - 2), "…"))}`);
    }
    const nested = this.renderNestedConversationTree(conversation, run, Math.max(1, width - 2));
    if (nested.length) lines.push(`  ${this.muted("subagents")}`, ...nested.map(line => `  ${line}`));

    if (run.status.kind === "done") {
      const output = run.status.output || run.status.error;
      if (output) {
        lines.push(
          this.muted("│"),
          `${run.status.error ? this.error("◆") : this.success("◆")} ${this.accent(run.status.error ? "Error" : "Final output")}`,
          ...new Markdown(output, 2, 0, markdownTheme(this.theme)).render(width),
        );
      }
    }

    lines.push("", this.muted(`enter inspect${this.canResumeConversation(conversation) ? " · r resume" : ""} · x remove`));
    if (this.promptTarget?.kind === "resume") lines.push("", this.accent("Resume conversation"), ...this.renderPrompt(width));
    if (this.actionError) lines.push(this.error(this.actionError));
    return lines;
  }

  private renderNestedConversationTree(conversation: ConversationSnapshot, run: RunSnapshot, width: number): string[] {
    const ownerKey = (conversationId: string, runId: string) => `${conversationId}\0${runId}`;
    const children = new Map<string, ConversationSnapshot[]>();
    for (const candidate of this.manager.listConversations()) {
      if (!candidate.parent) continue;
      const key = ownerKey(candidate.parent.conversationId, candidate.parent.runId);
      const siblings = children.get(key) ?? [];
      siblings.push(candidate);
      children.set(key, siblings);
    }

    const lines: string[] = [];
    const seen = new Set<string>();
    const visit = (siblings: readonly ConversationSnapshot[], prefix: string) => siblings.forEach((child, index) => {
      if (seen.has(child.conversationId)) return;
      seen.add(child.conversationId);
      const last = index === siblings.length - 1;
      const childRun = child.runs[0];
      const label = child.label || child.config.name;
      const agent = child.label ? ` · ${child.config.name}` : "";
      const status = childRun ? effectiveStatus(childRun.status) : "idle";
      const connector = `${prefix}${last ? "╰─" : "├─"}`;
      const content = `${this.muted(connector)} ${this.text(label)}${this.muted(agent)} ${this.muted("·")} ${childRun ? this.statusText(childRun, status) : this.muted(status)}`;
      lines.push(truncateToWidth(content, width, "…"));
      if (childRun) visit(children.get(ownerKey(child.conversationId, childRun.runId)) ?? [], `${prefix}${last ? "   " : `${this.muted("│")}  `}`);
    });
    visit(children.get(ownerKey(conversation.conversationId, run.runId)) ?? [], "");
    return lines;
  }

  private renderFilter(width: number): string {
    const input = this.activeFilter!;
    const suffix = this.page === "conversations" ? `  View: ${this.conversationMode === "flat" ? "[Flat] Tree" : "Flat [Tree]"}` : "";
    const available = Math.max(6, width - visibleWidth(suffix) - 3);
    const rendered = input.render(available)[0] ?? "";
    const value = input.getValue() || this.focusRegion === "filter" ? rendered : this.muted("Filter…");
    return truncateToWidth(`/ ${value}${suffix}`, width, "");
  }

  private renderDetail(width: number): string[] {
    const conversation = this.findConversation(this.detail!.conversationId);
    if (!conversation) return fitHeight([this.error("Conversation is no longer available.")], this.bodyHeight);
    const run = this.findRun(conversation, this.detail!.runId);
    if (!run) return fitHeight([this.muted("This conversation has no runs.")], this.bodyHeight);
    return fitHeight(compactViewport(this.renderConversationChronology(conversation, run, width), this.bodyHeight), this.bodyHeight);
  }

  private handleAgentAction(data: string): void {
    if (!isEnterKey(data, this.keybindings) && data.toLowerCase() !== "s") return;
    const agents = this.filteredAgents;
    const agent = agents[this.selectedAgent(agents)];
    if (agent) this.openPrompt({ kind: "agent", name: agent.name });
  }

  private handleConversationAction(data: string): void {
    const rows = this.conversationRows;
    const conversation = rows[this.selectedConversation(rows)]?.conversation;
    if (data.toLowerCase() === "t") { this.conversationMode = this.conversationMode === "flat" ? "tree" : "flat"; this.resetSelection(); this.requestRender(); return; }
    if (!conversation) return;
    if (isEnterKey(data, this.keybindings)) {
      const run = conversation.currentRun ?? conversation.runs.at(-1);
      this.detail = { conversationId: conversation.conversationId, ...(run ? { runId: run.runId } : {}) };
    } else if (data.toLowerCase() === "r") this.openResumePrompt(conversation.conversationId);
    else if (data.toLowerCase() === "x" || data.toLowerCase() === "c") this.removeConversation(conversation.conversationId);
    this.requestRender();
  }

  private openResumePrompt(conversationId: string): void {
    const conversation = this.findConversation(conversationId);
    if (!conversation || !this.canResumeConversation(conversation)) return;
    this.openPrompt({ kind: "resume", conversationId });
  }

  private openPrompt(target: PromptTarget): void {
    this.promptTarget = target;
    this.prompt.setValue("");
    this.actionError = "";
    this.setFocus("prompt");
  }

  private closePrompt(): void {
    this.promptTarget = undefined;
    this.prompt.setValue("");
    this.actionError = "";
    this.setFocus("list");
  }

  private submitPrompt(value: string): void {
    const target = this.promptTarget;
    const prompt = value.trim();
    if (!target || !prompt) return;
    try {
      if (target.kind === "agent") {
        if (!this.options.agents.some(agent => agent.name === target.name)) throw new Error(`Agent ${target.name} is no longer available.`);
        this.options.onStart(target.name, prompt);
      } else {
        const conversation = this.findConversation(target.conversationId);
        if (!conversation || !this.canResumeConversation(conversation)) throw new Error("Conversation is no longer available to resume.");
        this.options.onResume(target.conversationId, prompt);
      }
      this.closePrompt();
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error);
      this.options.notify(this.actionError, "warning");
      this.requestRender();
    }
  }

  private removeConversation(conversationId: string): void {
    this.options.onRemove?.(conversationId);
    if (this.detail?.conversationId === conversationId) this.detail = undefined;
    if (this.selectedConversationId === conversationId) this.selectedConversationId = undefined;
  }

  private moveSelection(delta: number): void {
    if (this.page === "agents") {
      const agents = this.filteredAgents;
      const index = clamp(this.selectedAgent(agents) + delta, 0, Math.max(0, agents.length - 1));
      this.selected.agents = index;
      this.selectedAgentName = agents[index]?.name;
    } else {
      const rows = this.conversationRows;
      const index = clamp(this.selectedConversation(rows) + delta, 0, Math.max(0, rows.length - 1));
      this.selected.conversations = index;
      this.selectedConversationId = rows[index]?.conversation.conversationId;
    }
    this.requestRender();
  }

  private switchPage(delta: number): void {
    const index = PAGES.indexOf(this.page);
    this.page = PAGES[(index + delta + PAGES.length) % PAGES.length];
    this.closePrompt();
  }

  private resetSelection(): void {
    this.selected[this.page] = 0;
    if (this.page === "agents") this.selectedAgentName = undefined;
    if (this.page === "conversations") this.selectedConversationId = undefined;
  }

  private selectedConversation(rows = this.conversationRows): number {
    const identityIndex = this.selectedConversationId ? rows.findIndex(row => row.conversation.conversationId === this.selectedConversationId) : -1;
    const index = identityIndex >= 0 ? identityIndex : clamp(this.selected.conversations, 0, Math.max(0, rows.length - 1));
    this.selected.conversations = index;
    this.selectedConversationId = rows[index]?.conversation.conversationId;
    return index;
  }

  private selectedAgent(agents = this.filteredAgents): number {
    const identityIndex = this.selectedAgentName ? agents.findIndex(agent => agent.name === this.selectedAgentName) : -1;
    const index = identityIndex >= 0 ? identityIndex : clamp(this.selected.agents, 0, Math.max(0, agents.length - 1));
    this.selected.agents = index;
    this.selectedAgentName = agents[index]?.name;
    return index;
  }

  private renderPrompt(width: number): string[] { return this.prompt.render(Math.max(8, width)); }
  private canResumeConversation(conversation: ConversationSnapshot): boolean {
    return conversation.canResume && conversation.runs.at(-1)?.status.kind === "done";
  }
  private setFocus(region: FocusRegion): void { this.focusRegion = region; this.syncFocus(); this.requestRender(); }
  private syncFocus(): void {
    this.filters.conversations.focused = this._focused && this.focusRegion === "filter" && this.page === "conversations";
    this.filters.agents.focused = this._focused && this.focusRegion === "filter" && this.page === "agents";
    this.prompt.focused = this._focused && this.focusRegion === "prompt";
  }
  private requestRender(): void { this.tui.requestRender(); }
  private findConversation(id: string): ConversationSnapshot | undefined { return this.manager.listConversations().find(conversation => conversation.conversationId === id); }
  private findRun(conversation: ConversationSnapshot, runId?: string): RunSnapshot | undefined { return runId ? conversation.runs.find(run => run.runId === runId) : conversation.currentRun ?? conversation.runs.at(-1); }
  private get conversationRows() { return projectConversations(this.manager.listConversations(), { mode: this.conversationMode, query: this.filters.conversations.getValue() }); }
  private get filteredAgents() { return filterAgents(this.options.agents, this.filters.agents.getValue()); }
  private get selectedListLine(): number {
    return (this.page === "agents" ? this.selectedAgent(this.filteredAgents) : this.selectedConversation(this.conversationRows)) * 4;
  }
  private get activeFilter(): Input | undefined { return this.page === "conversations" ? this.filters.conversations : this.page === "agents" ? this.filters.agents : undefined; }
  private bold(text: string): string { return this.theme.bold?.(text) ?? text; }
  private text(text: string): string { return this.theme.fg?.("text", text) ?? text; }
  private accent(text: string): string { return this.theme.fg?.("accent", this.bold(text)) ?? text; }
  private success(text: string): string { return this.theme.fg?.("success", text) ?? text; }
  private muted(text: string): string { return this.theme.fg?.("muted", text) ?? text; }
  private dim(text: string): string { return this.theme.fg?.("dim", text) ?? text; }
  private error(text: string): string { return this.theme.fg?.("error", text) ?? text; }
  private border(text: string): string { return this.theme.fg?.("border", text) ?? text; }
  private tag(name: string, value: string): string { return `${this.muted(name)} ${this.theme.fg?.("accent", value) ?? value}`; }
  private statusText(run: RunSnapshot, text: string): string {
    if (run.status.kind === "queued" || run.status.kind === "running") return this.theme.fg?.("warning", text) ?? text;
    if (run.status.outcome === "completed") return this.success(text);
    if (run.status.outcome === "error") return this.error(text);
    if (run.status.outcome === "aborted" || run.status.outcome === "interrupted") return this.theme.fg?.("warning", text) ?? text;
    return this.dim(text);
  }
  private statusAccent(run: RunSnapshot, text: string): string { return this.statusText(run, text); }
  private row(content: string, width: number): string { return `${this.border("│")}${pad(content, width)}${this.border("│")}`; }
  private helpText(): string {
    if (this.focusRegion === "prompt") return "enter submit · esc cancel";
    if (this.detail) return "r resume · x remove · esc back";
    if (this.page === "agents") return "↑↓ select · / filter · enter/s start · tab pages · esc close";
    if (this.page === "conversations") return "↑↓ select · enter inspect · / filter · t flat/tree · r resume · x remove · tab pages · esc close";
    return "↑↓ select · enter change · tab pages · esc close";
  }
}

function requestedConfigLabel(conversation: ConversationSnapshot): string {
  const { model, thinking } = conversation.requestedOverrides ?? {};
  if (model && thinking) return `${model}:${thinking}`;
  if (model) return model;
  return thinking ? `thinking ${thinking}` : "";
}
function runElapsedMs(run: RunSnapshot, now = Date.now()): number {
  const start = run.status.kind === "queued" ? run.status.queuedAt : run.status.kind === "running" ? run.status.startedAt : run.status.startedAt ?? run.createdAt;
  const end = run.status.kind === "done" ? run.status.completedAt : now;
  return Math.max(0, end - start);
}
function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds - minutes * 60);
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}
function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens} tokens`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m tokens`;
}
function runRecency(run: RunSnapshot, now = Date.now()): string {
  if (run.status.kind === "running") return "active now";
  const timestamp = run.status.kind === "queued" ? run.status.queuedAt : run.status.completedAt;
  const relative = relativeTime(now - timestamp);
  if (run.status.kind === "queued") return `queued ${relative}`;
  const verb = run.status.outcome === "completed" ? "finished" : run.status.outcome === "error" ? "failed" : run.status.outcome;
  return `${verb} ${relative}`;
}
function relativeTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 2) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function plural(amount: number, noun: string): string { return `${noun}${amount === 1 ? "" : "s"}`; }
function activitySummary(run: RunSnapshot): string {
  const parts = [
    `${run.activity.turns} turn${run.activity.turns === 1 ? "" : "s"}`,
    `${run.activity.toolHistory.length} tool${run.activity.toolHistory.length === 1 ? "" : "s"}`,
  ];
  if (run.activity.compactions > 0) parts.push(`${run.activity.compactions} compaction${run.activity.compactions === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
function wrapParagraphs(text: string, width: number): string[] {
  return text.split(/\n\s*\n/).flatMap((paragraph, index) => [
    ...(index ? [""] : []),
    ...wrapTextWithAnsi(compact(paragraph), Math.max(1, width)),
  ]);
}
function pinBottom(content: string[], bottom: string[], height: number): string[] {
  const available = Math.max(0, height - bottom.length);
  const visible = content.slice(0, available);
  return [...visible, ...Array(Math.max(0, available - visible.length)).fill(""), ...bottom];
}
function markdownTheme(theme: Theme): MarkdownTheme {
  const color = (name: ThemeColor) => (text: string) => theme.fg?.(name, text) ?? text;
  return { heading: color("mdHeading"), link: color("mdLink"), linkUrl: color("mdLinkUrl"), code: color("mdCode"), codeBlock: color("mdCodeBlock"), codeBlockBorder: color("mdCodeBlockBorder"), quote: color("mdQuote"), quoteBorder: color("mdQuoteBorder"), hr: color("mdHr"), listBullet: color("mdListBullet"), bold: text => theme.bold?.(text) ?? text, italic: text => theme.italic?.(text) ?? text, strikethrough: text => theme.strikethrough?.(text) ?? text, underline: text => text };
}
function compact(text?: string): string { return text?.replace(/\s+/g, " ").trim() || "No description"; }
function count(values: readonly unknown[] | undefined, noun: string): string { const amount = values?.length ?? 0; return `${amount} ${noun}${amount === 1 ? "" : "s"}`; }
function center(text: string, width: number): string { return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2)))}${text}`; }
function pad(text: string, width: number): string { const fitted = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text; return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`; }
function fitHeight(lines: string[], height: number): string[] { return [...lines.slice(0, height), ...Array(Math.max(0, height - lines.length)).fill("")]; }
function viewportAt(lines: string[], height: number, selectedLine: number): string[] {
  if (lines.length <= height) return lines;
  const start = clamp(selectedLine - Math.floor(height / 2), 0, lines.length - height);
  return lines.slice(start, start + height);
}
function compactViewport(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  const tail = Math.min(5, Math.max(1, height - 2));
  const head = Math.max(1, height - tail - 1);
  return [...lines.slice(0, head), `… ${lines.length - head - tail} more`, ...lines.slice(-tail)];
}
