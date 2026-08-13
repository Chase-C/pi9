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
import type { AgentDefinition } from "../agents.js";
import { effectiveStatus, type ConversationSnapshot, type GenerationSnapshot } from "../conversation.js";
import { formatElapsed, formatTokens, generationElapsedMs, statusColor } from "../generation-format.js";
import type { SubagentRuntime } from "../runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "../settings.js";
import { clamp, isCancelKey, isDownKey, isEnterKey, isPageDownKey, isPageUpKey, isShiftTabKey, isUpKey, type SubagentKeybindings } from "./input.js";
import { filterAgents, projectConversations } from "./overlay-model.js";
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
  agents: readonly AgentDefinition[];
  settings: SubagentSettings;
  notify(message: string, level?: string): void;
  onSettingsChange(change: SubagentSettingsChange): SubagentSettings | void;
  onStart(agent: string, prompt: string): string | undefined;
  onResume(conversationId: string, prompt: string): void;
  onCancel?(subagentId: string): void;
  onRemove?(conversationId: string): void;
}

export class SubagentOverlayComponent implements Component, Focusable {
  private _focused = false;
  private page: SubagentOverlayPage;
  private focusRegion: FocusRegion = "list";
  private readonly selected: Record<SubagentOverlayPage, number> = { conversations: 0, agents: 0, settings: 0 };
  private selectedConversationId?: string;
  private selectedAgentName?: string;
  private readonly filters = { conversations: new Input(), agents: new Input() };
  private readonly prompt = new Input();
  private promptTarget?: PromptTarget;
  private detail?: { conversationId: string; generation?: number };
  private actionError = "";
  private inspectorScrollOffset = 0;
  private readonly settings: SubagentSettingsComponent;
  private readonly unsubscribe: () => void;
  private readonly bodyHeight: number;
  private readonly automaticCollectionAttempts = new Set<string>();

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
      () => { this.page = "conversations"; this.collectSelectedConversation(); this.requestRender(); },
      () => this.requestRender(),
    );
    for (const input of Object.values(this.filters)) {
      input.onEscape = () => this.setFocus("list");
      input.onSubmit = () => this.setFocus("list");
    }
    this.prompt.onEscape = () => this.closePrompt();
    this.prompt.onSubmit = value => this.submitPrompt(value);
    this.unsubscribe = manager.onConversationUpdate(() => {
      this.collectSelectedConversation();
      this.requestRender();
    });
    this.collectSelectedConversation();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.syncFocus(); }

  handleInput(data: string): void {
    if (this.focusRegion === "filter") {
      const input = this.activeFilter;
      if (!input) return;
      const before = input.getValue();
      input.handleInput(data);
      if (before !== input.getValue()) {
        this.resetSelection();
        this.collectSelectedConversation();
      }
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
      else if (data.toLowerCase() === "c") this.cancelGeneration(this.detail.conversationId, this.detail.generation);
      else if (data.toLowerCase() === "x") this.removeConversation(this.detail.conversationId);
      this.requestRender();
      return;
    }
    if (this.page === "settings" && this.settings.isEditing) { this.settings.handleInput(data); return; }
    if (isCancelKey(data, this.keybindings) || data === "q") { this.done(); return; }
    if (data === "\t") { this.switchPage(1); return; }
    if (isShiftTabKey(data)) { this.switchPage(-1); return; }
    if ((this.page === "conversations" || this.page === "agents") && data === "/") { this.setFocus("filter"); return; }
    if (this.page === "settings") { this.settings.handleInput(data); return; }
    if (isPageUpKey(data, this.keybindings)) { this.scrollInspector(-1); return; }
    if (isPageDownKey(data, this.keybindings)) { this.scrollInspector(1); return; }
    if (isUpKey(data, this.keybindings)) { this.moveSelection(-1); return; }
    if (isDownKey(data, this.keybindings)) { this.moveSelection(1); return; }
    if (this.page === "agents") this.handleAgentAction(data);
    else this.handleConversationAction(data);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const header = this.detail ? this.renderDetailTitle(innerWidth) : this.renderTabs(innerWidth);
    const help = this.renderHelp(innerWidth);
    const bodyHeight = Math.max(1, this.bodyHeight - help.length + 1);
    const body = this.detail
      ? this.renderDetail(innerWidth, bodyHeight)
      : this.page === "settings"
        ? fitHeight(this.settings.render(Math.max(1, innerWidth - 2)), bodyHeight)
        : this.renderBrowser(innerWidth, bodyHeight);
    const lines = [
      this.border(`╭${"─".repeat(innerWidth)}╮`),
      this.row(header, innerWidth),
      this.border(`├${"─".repeat(innerWidth)}┤`),
      ...body.map(line => this.row(line, innerWidth)),
      this.border(`├${"─".repeat(innerWidth)}┤`),
      ...help.map(line => this.row(line, innerWidth)),
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
    const generation = conversation && this.findGeneration(conversation, this.detail!.generation);
    const title = conversation ? `${conversation.agent.name} · ${conversation.conversationId}${generation ? ` · generation ${generation.generation}` : ""}` : "Conversation unavailable";
    return truncateToWidth(` ${this.accent("Subagents")}  ${title}`, width, "");
  }

  private renderBrowser(width: number, bodyHeight: number): string[] {
    const wide = width >= 80;
    const leftWidth = wide ? Math.max(30, Math.floor(width * 0.36)) : width;
    const rightWidth = wide ? width - leftWidth - 3 : width;
    const list = this.renderList(Math.max(1, leftWidth - 2));
    const inspector = this.renderInspector(Math.max(1, rightWidth - 2));
    const filter = this.renderFilter(Math.max(1, leftWidth - 2));

    if (!wide) {
      if (bodyHeight < 4) {
        const listHeight = Math.max(0, bodyHeight - 1);
        return [
          ...fitHeight(this.renderListViewport(list, listHeight, Math.max(1, leftWidth - 2)), listHeight),
          ` ${filter}`,
        ];
      }
      const contentHeight = bodyHeight - 2;
      const listHeight = Math.ceil(contentHeight / 2);
      const inspectorHeight = contentHeight - listHeight;
      return [
        ...fitHeight(this.renderListViewport(list, listHeight, Math.max(1, leftWidth - 2)), listHeight),
        ` ${filter}`,
        this.border("─".repeat(width)),
        ...fitHeight(this.renderInspectorViewport(inspector, inspectorHeight, Math.max(1, rightWidth - 2)), inspectorHeight),
      ];
    }

    const topPadding = bodyHeight > 1 ? 1 : 0;
    const listHeight = Math.max(0, bodyHeight - topPadding - 1);
    const left = [...(topPadding ? [""] : []), ...fitHeight(this.renderListViewport(list, listHeight, Math.max(1, leftWidth - 2)), listHeight), filter];
    const right = fitHeight(this.renderInspectorViewport(inspector, bodyHeight, Math.max(1, rightWidth - 2), true), bodyHeight);
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
      const generation = conversation.currentGeneration ?? conversation.generations.at(-1);
      const isSelected = index === selected;
      const firstPrefix = `${isSelected ? this.accent("┃ ") : "  "}${this.muted(row.treePrefix ?? "")}`;
      const continuationPrefix = `${isSelected ? this.accent("┃ ") : "  "}${this.muted(row.treeContinuation ?? "")}`;
      const identity = conversation.label || conversation.agent.name;
      const name = isSelected ? this.accent(identity) : identity;
      const agent = conversation.label ? ` · ${conversation.agent.name}` : "";
      const config = requestedConfigLabel(conversation);
      const title = `${name}${this.muted(`${agent}${config ? ` (${config})` : ""}`)}`;
      const status = generation ? effectiveStatus(generation.status) : "idle";
      const elapsed = generation ? formatElapsed(generationElapsedMs(generation)) : "0ms";
      const tokens = generation ? formatTokens(generation.usage.totalTokens) : "0 tokens";
      const timeline = generation ? generationRecency(generation) : "idle";
      const activity = `${generation?.activity.turns ?? 0} ${plural(generation?.activity.turns ?? 0, "turn")} · ${generation?.activity.toolHistory.length ?? 0} ${plural(generation?.activity.toolHistory.length ?? 0, "tool")}`;
      return [
        truncateToWidth(`${firstPrefix}${title}`, width, "…"),
        truncateToWidth(`${continuationPrefix}${generation ? this.statusText(generation, status) : this.muted(status)} ${this.muted(`· ${elapsed} · ${tokens}`)}`, width, "…"),
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
    const latest = conversation.currentGeneration ?? conversation.generations.at(-1);
    return latest ? this.renderConversationChronology(conversation, latest, width) : [];
  }

  private renderAgentInspector(agent: AgentDefinition, width: number): string[] {
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
    if (this.promptTarget?.kind !== "agent") return lines;
    return [
      ...lines,
      "",
      this.accent("Task prompt"),
      ...this.renderPrompt(width),
      ...(this.actionError ? [this.error(this.actionError)] : []),
    ];
  }

  private renderConversationChronology(conversation: ConversationSnapshot, generation: GenerationSnapshot, width: number): string[] {
    const generationIndex = conversation.generations.findIndex(candidate => candidate.generation === generation.generation);
    const previousGenerations = conversation.generations.slice(0, Math.max(0, generationIndex));
    const status = effectiveStatus(generation.status);
    const lines = [
      `${this.accent(conversation.label || conversation.agent.name)} ${this.muted(`· ${conversation.agent.name} · ${status}`)}`,
      "",
      `${this.tag("conversation", conversation.conversationId)} ${this.muted("·")} ${this.tag("generation", `#${generation.generation}`)}`,
      `${this.tag("model", conversation.effectiveConfig?.model ?? conversation.requestedConfig.model ?? "default")} ${this.muted("·")} ${this.tag("thinking", conversation.effectiveConfig?.thinking ?? conversation.requestedConfig.thinking ?? "default")}`,
      ...(conversation.effectiveConfig ? [this.tag("cwd", conversation.effectiveConfig.cwd)] : []),
      "",
    ];

    if (previousGenerations.length) {
      lines.push(`${this.muted("◆")} ${this.accent("Previous generations")}`);
      for (const previous of previousGenerations) {
        const label = conversation.label || compact(previous.prompt);
        const failure = previous.status.kind === "done" && previous.status.outcome !== "completed"
          ? ` ${this.statusText(previous, `[${previous.status.outcome}]`)}`
          : "";
        const summary = `${label}${failure} ${this.muted(`· generation #${previous.generation} · ${activitySummary(previous)} · ${formatTokens(previous.usage.totalTokens)}`)}`;
        lines.push(`  ${truncateToWidth(summary, Math.max(1, width - 2), "…")}`);
      }
      lines.push(this.muted("│"));
    }

    lines.push(
      `${this.muted("◆")} ${this.accent("Current prompt")}`,
      ...wrapTextWithAnsi(generation.prompt, Math.max(1, width - 2)).map(line => `  ${line}`),
      this.muted("│"),
      `${this.statusAccent(generation, "●")} ${this.accent("Activity")}`,
      `  ${this.muted(`${activitySummary(generation)} · ${formatElapsed(generationElapsedMs(generation))} · ${formatTokens(generation.usage.totalTokens)}`)}`,
    );
    if (generation.status.kind !== "done" && generation.activity.messageSnippet) {
      lines.push(`  ${this.dim(truncateToWidth(compact(generation.activity.messageSnippet), Math.max(1, width - 2), "…"))}`);
    }
    const nested = this.renderNestedConversationTree(conversation, generation, Math.max(1, width - 2));
    if (nested.length) lines.push(`  ${this.muted("subagents")}`, ...nested.map(line => `  ${line}`));

    if (generation.status.kind === "done") {
      const output = generation.status.output || generation.status.error;
      if (output) {
        lines.push(
          this.muted("│"),
          `${generation.status.error ? this.error("◆") : this.success("◆")} ${this.accent(generation.status.error ? "Error" : "Final output")}`,
          ...new Markdown(output, 2, 0, markdownTheme(this.theme)).render(width),
        );
      }
    }

    if (this.promptTarget?.kind === "resume") lines.push("", this.accent("Resume conversation"), ...this.renderPrompt(width));
    if (this.actionError) lines.push(this.error(this.actionError));
    return lines;
  }

  private renderNestedConversationTree(conversation: ConversationSnapshot, generation: GenerationSnapshot, width: number): string[] {
    type LineageNode = { conversation: ConversationSnapshot; generation: GenerationSnapshot };
    const children = new Map<string, LineageNode[]>();
    const lineageKey = (conversationId: string, generationNumber: number) => `${conversationId}\u0000${generationNumber}`;
    for (const candidate of this.manager.listConversations()) {
      if (!candidate.parentConversationId) continue;
      for (const candidateGeneration of candidate.generations) {
        if (candidateGeneration.startedInParentGeneration === undefined) continue;
        const key = lineageKey(candidate.parentConversationId, candidateGeneration.startedInParentGeneration);
        const siblings = children.get(key) ?? [];
        siblings.push({ conversation: candidate, generation: candidateGeneration });
        children.set(key, siblings);
      }
    }

    const lines: string[] = [];
    const seen = new Set<string>();
    const visit = (siblings: readonly LineageNode[], prefix: string) => siblings.forEach((child, index) => {
      const childKey = lineageKey(child.conversation.conversationId, child.generation.generation);
      if (seen.has(childKey)) return;
      seen.add(childKey);
      const last = index === siblings.length - 1;
      const label = child.conversation.label || child.conversation.agent.name;
      const agent = child.conversation.label ? ` · ${child.conversation.agent.name}` : "";
      const status = effectiveStatus(child.generation.status);
      const connector = `${prefix}${last ? "╰─" : "├─"}`;
      const content = `${this.muted(connector)} ${this.text(label)}${this.muted(agent)} ${this.muted("·")} ${this.statusText(child.generation, status)}`;
      lines.push(truncateToWidth(content, width, "…"));
      visit(children.get(childKey) ?? [], `${prefix}${last ? "   " : `${this.muted("│")}  `}`);
    });
    visit(children.get(lineageKey(conversation.conversationId, generation.generation)) ?? [], "");
    return lines;
  }

  private renderFilter(width: number): string {
    const input = this.activeFilter!;
    const rendered = input.render(Math.max(6, width - 3))[0] ?? "";
    const value = input.getValue() || this.focusRegion === "filter" ? rendered : this.muted("Filter…");
    return truncateToWidth(`/ ${value}`, width, "");
  }

  private renderDetail(width: number, bodyHeight: number): string[] {
    const conversation = this.findConversation(this.detail!.conversationId);
    if (!conversation) return fitHeight([this.error("Conversation is no longer available.")], bodyHeight);
    const generation = this.findGeneration(conversation, this.detail!.generation);
    if (!generation) return fitHeight([this.muted("Generation is no longer available.")], bodyHeight);
    return fitHeight(compactViewport(this.renderConversationChronology(conversation, generation, width), bodyHeight), bodyHeight);
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
    if (!conversation) return;
    if (isEnterKey(data, this.keybindings)) {
      const generation = conversation.currentGeneration ?? conversation.generations.at(-1);
      this.detail = { conversationId: conversation.conversationId, ...(generation ? { generation: generation.generation } : {}) };
    } else if (data.toLowerCase() === "r") this.openResumePrompt(conversation.conversationId);
    else if (data.toLowerCase() === "c") this.cancelGeneration(conversation.conversationId);
    else if (data.toLowerCase() === "x") this.removeConversation(conversation.conversationId);
    this.requestRender();
  }

  private openResumePrompt(conversationId: string): void {
    const conversation = this.findConversation(conversationId);
    if (!conversation || !this.isResumeAvailable(conversation)) return;
    this.openPrompt({ kind: "resume", conversationId });
  }

  private openPrompt(target: PromptTarget): void {
    this.promptTarget = target;
    this.prompt.setValue("");
    this.actionError = "";
    this.inspectorScrollOffset = Number.MAX_SAFE_INTEGER;
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
        if (!conversation || !this.isResumeAvailable(conversation)) throw new Error("Conversation is no longer available to resume.");
        this.options.onResume(target.conversationId, prompt);
      }
      this.closePrompt();
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error);
      this.options.notify(this.actionError, "warning");
      this.requestRender();
    }
  }

  private cancelGeneration(conversationId: string, generationNumber?: number): void {
    const conversation = this.findConversation(conversationId);
    if (!conversation || conversation.parentConversationId || conversation.isStopping) return;
    const generation = this.findGeneration(conversation, generationNumber);
    if (generation?.status.kind === "queued" || generation?.status.kind === "running") this.options.onCancel?.(conversation.conversationId);
  }

  private removeConversation(conversationId: string): void {
    const conversation = this.findConversation(conversationId);
    if (!conversation || !this.isRemoveAvailable(conversation)) return;
    this.options.onRemove?.(conversationId);
    if (this.detail?.conversationId === conversationId) this.detail = undefined;
    if (this.selectedConversationId === conversationId) this.selectedConversationId = undefined;
  }

  private moveSelection(delta: number): void {
    this.inspectorScrollOffset = 0;
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
      this.collectSelectedConversation();
    }
    this.requestRender();
  }

  private switchPage(delta: number): void {
    const index = PAGES.indexOf(this.page);
    this.page = PAGES[(index + delta + PAGES.length) % PAGES.length];
    this.inspectorScrollOffset = 0;
    this.closePrompt();
    this.collectSelectedConversation();
  }

  private resetSelection(): void {
    this.inspectorScrollOffset = 0;
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
  private collectSelectedConversation(): void {
    if (this.page !== "conversations") return;
    const rows = this.conversationRows;
    const conversation = rows[this.selectedConversation(rows)]?.conversation;
    const generation = conversation?.generations.at(-1);
    if (!conversation || conversation.parentConversationId || !generation) return;

    const attempt = `${conversation.conversationId}\u0000${generation.generation}\u0000${generation.status.kind}`;
    if (this.automaticCollectionAttempts.has(attempt)) return;
    this.automaticCollectionAttempts.add(attempt);
    try {
      this.manager.collectSubagentForUser(conversation.conversationId);
    } catch {
      this.automaticCollectionAttempts.delete(attempt);
    }
  }
  private isResumeAvailable(conversation: ConversationSnapshot): boolean {
    return !conversation.parentConversationId && conversation.resumeAllowed;
  }
  private isRemoveAvailable(conversation: ConversationSnapshot): boolean {
    if (conversation.parentConversationId) return false;
    try {
      return this.manager.projectSubagent(conversation.conversationId).actionHints.includes("remove");
    } catch {
      return false;
    }
  }
  private setFocus(region: FocusRegion): void { this.focusRegion = region; this.syncFocus(); this.requestRender(); }
  private syncFocus(): void {
    this.filters.conversations.focused = this._focused && this.focusRegion === "filter" && this.page === "conversations";
    this.filters.agents.focused = this._focused && this.focusRegion === "filter" && this.page === "agents";
    this.prompt.focused = this._focused && this.focusRegion === "prompt";
    this.settings.focused = this._focused && this.focusRegion === "list" && this.page === "settings";
  }
  private scrollInspector(direction: -1 | 1): void {
    const pageSize = Math.max(1, this.bodyHeight - 3);
    this.inspectorScrollOffset = Math.max(0, this.inspectorScrollOffset + direction * pageSize);
    this.requestRender();
  }
  private renderInspectorViewport(lines: string[], height: number, width: number, topPadding = false): string[] {
    const paddedLength = lines.length + (topPadding ? 1 : 0);
    if (paddedLength <= height || height < 3) {
      const padded = topPadding ? ["", ...lines] : lines;
      this.inspectorScrollOffset = clamp(this.inspectorScrollOffset, 0, Math.max(0, padded.length - height));
      return padded.slice(this.inspectorScrollOffset, this.inspectorScrollOffset + height);
    }

    const contentHeight = height - 2;
    const maxOffset = lines.length - contentHeight;
    this.inspectorScrollOffset = clamp(this.inspectorScrollOffset, 0, maxOffset);
    const above = this.inspectorScrollOffset;
    const below = lines.length - this.inspectorScrollOffset - contentHeight;
    return [
      above ? this.muted(center(`▲ ${above} more above`, width)) : "",
      ...lines.slice(this.inspectorScrollOffset, this.inspectorScrollOffset + contentHeight),
      below ? this.muted(center(`▼ ${below} more below`, width)) : "",
    ];
  }
  private requestRender(): void { this.tui.requestRender(); }
  private findConversation(id: string): ConversationSnapshot | undefined { return this.manager.listConversations().find(conversation => conversation.conversationId === id); }
  private findGeneration(conversation: ConversationSnapshot, generation?: number): GenerationSnapshot | undefined { return generation ? conversation.generations.find(candidate => candidate.generation === generation) : conversation.currentGeneration ?? conversation.generations.at(-1); }
  private get conversationRows() { return projectConversations(this.manager.listConversations(), { query: this.filters.conversations.getValue() }); }
  private get filteredAgents() { return filterAgents(this.options.agents, this.filters.agents.getValue()); }
  private get selectedListLine(): number {
    return (this.page === "agents" ? this.selectedAgent(this.filteredAgents) : this.selectedConversation(this.conversationRows)) * 4;
  }
  private get activeFilter(): Input | undefined { return this.page === "conversations" ? this.filters.conversations : this.page === "agents" ? this.filters.agents : undefined; }
  private bold(text: string): string { return this.theme.bold?.(text) ?? text; }
  private text(text: string): string { return this.theme.fg?.("text", text) ?? text; }
  private accent(text: string): string { return this.theme.fg?.("accent", this.bold(text)) ?? text; }
  private success(text: string): string { return this.theme.fg?.("success", text) ?? text; }
  private warning(text: string): string { return this.theme.fg?.("warning", text) ?? text; }
  private muted(text: string): string { return this.theme.fg?.("muted", text) ?? text; }
  private dim(text: string): string { return this.theme.fg?.("dim", text) ?? text; }
  private error(text: string): string { return this.theme.fg?.("error", text) ?? text; }
  private border(text: string): string { return this.theme.fg?.("border", text) ?? text; }
  private tag(name: string, value: string): string { return `${this.muted(name)} ${this.theme.fg?.("accent", value) ?? value}`; }
  private statusText(generation: GenerationSnapshot, text: string): string {
    return this.theme.fg?.(statusColor(effectiveStatus(generation.status)), text) ?? text;
  }
  private statusAccent(generation: GenerationSnapshot, text: string): string { return this.statusText(generation, text); }
  private row(content: string, width: number): string { return `${this.border("│")}${pad(content, width)}${this.border("│")}`; }
  private renderHelp(width: number): string[] {
    if (this.focusRegion === "prompt") return [this.muted("enter submit · esc cancel")];
    if (this.detail) {
      const conversation = this.findConversation(this.detail.conversationId);
      const generation = conversation && this.findGeneration(conversation, this.detail.generation);
      const actions = conversation && generation ? this.conversationActionHelp(conversation, generation, false) : "";
      return [this.dim("esc back"), ...(actions ? wrapTextWithAnsi(actions, width) : [])];
    }
    if (this.page === "settings") {
      return [this.muted(this.settings.isEditing ? "type value · enter save · esc cancel" : "↑↓ select · enter/space change · tab pages · esc close")];
    }

    const navigation = "↑↓ select · PgUp/PgDn scroll details · / filter · tab pages · esc close";
    const conversation = this.page === "conversations"
      ? this.conversationRows[this.selectedConversation(this.conversationRows)]?.conversation
      : undefined;
    const agent = this.page === "agents"
      ? this.filteredAgents[this.selectedAgent(this.filteredAgents)]
      : undefined;
    const generation = conversation?.currentGeneration ?? conversation?.generations.at(-1);
    const actions = this.page === "agents"
      ? agent ? this.actionChip("enter/s", `delegate to ${agent.name}`) : ""
      : conversation && generation ? this.conversationActionHelp(conversation, generation) : "";
    return dividedHelp(this.muted(navigation), actions, width, text => this.border(text));
  }

  private conversationActionHelp(conversation: ConversationSnapshot, generation: GenerationSnapshot, includeInspect = true): string {
    const actions: Array<[string, string]> = [];
    if (includeInspect) actions.push(["enter", "inspect"]);
    if (!conversation.parentConversationId && !conversation.isStopping && (generation.status.kind === "queued" || generation.status.kind === "running")) actions.push(["c", "cancel"]);
    if (this.isResumeAvailable(conversation)) actions.push(["r", "resume"]);
    if (this.isRemoveAvailable(conversation)) actions.push(["x", "remove"]);
    return actions.map(([key, label]) => this.actionChip(key, label)).join("  ");
  }

  private actionChip(key: string, label: string): string {
    return `${this.warning(this.bold(`[${key}]`))} ${this.theme.fg?.("accent", label) ?? label}`;
  }
}

function requestedConfigLabel(conversation: ConversationSnapshot): string {
  const { model, thinking } = conversation.requestedOverrides ?? {};
  if (model && thinking) return `${model}:${thinking}`;
  if (model) return model;
  return thinking ? `thinking ${thinking}` : "";
}
function generationRecency(generation: GenerationSnapshot, now = Date.now()): string {
  if (generation.status.kind === "running") return "active now";
  const timestamp = generation.status.kind === "queued" ? generation.status.queuedAt : generation.status.completedAt;
  const relative = relativeTime(now - timestamp);
  if (generation.status.kind === "queued") return `queued ${relative}`;
  const verb = generation.status.outcome === "completed" ? "finished" : generation.status.outcome === "error" ? "failed" : generation.status.outcome;
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
function activitySummary(generation: GenerationSnapshot): string {
  const parts = [
    `${generation.activity.turns} turn${generation.activity.turns === 1 ? "" : "s"}`,
    `${generation.activity.toolHistory.length} tool${generation.activity.toolHistory.length === 1 ? "" : "s"}`,
  ];
  if (generation.activity.compactions > 0) parts.push(`${generation.activity.compactions} compaction${generation.activity.compactions === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
function wrapParagraphs(text: string, width: number): string[] {
  return text.split(/\n\s*\n/).flatMap((paragraph, index) => [
    ...(index ? [""] : []),
    ...wrapTextWithAnsi(compact(paragraph), Math.max(1, width)),
  ]);
}
function markdownTheme(theme: Theme): MarkdownTheme {
  const color = (name: ThemeColor) => (text: string) => theme.fg?.(name, text) ?? text;
  return { heading: color("mdHeading"), link: color("mdLink"), linkUrl: color("mdLinkUrl"), code: color("mdCode"), codeBlock: color("mdCodeBlock"), codeBlockBorder: color("mdCodeBlockBorder"), quote: color("mdQuote"), quoteBorder: color("mdQuoteBorder"), hr: color("mdHr"), listBullet: color("mdListBullet"), bold: text => theme.bold?.(text) ?? text, italic: text => theme.italic?.(text) ?? text, strikethrough: text => theme.strikethrough?.(text) ?? text, underline: text => text };
}
function compact(text?: string): string { return text?.replace(/\s+/g, " ").trim() || "No description"; }
function count(values: readonly unknown[] | undefined, noun: string): string { const amount = values?.length ?? 0; return `${amount} ${noun}${amount === 1 ? "" : "s"}`; }
function center(text: string, width: number): string { return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2)))}${text}`; }
function pad(text: string, width: number): string { const fitted = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text; return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`; }
function dividedHelp(navigation: string, actions: string, width: number, border: (text: string) => string): string[] {
  if (width < 80) return [...wrapTextWithAnsi(navigation, width), ...(actions ? wrapTextWithAnsi(actions, width) : [])];
  const leftWidth = Math.max(30, Math.floor(width * 0.36));
  const rightWidth = width - leftWidth - 3;
  const left = wrapTextWithAnsi(navigation, leftWidth);
  const right = actions ? wrapTextWithAnsi(actions, rightWidth) : [];
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => `${pad(left[index] ?? "", leftWidth)} ${border("│")} ${pad(right[index] ?? "", rightWidth)}`);
}
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
