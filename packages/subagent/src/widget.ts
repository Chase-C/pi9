import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type { ConversationSnapshot, ConversationUpdateKind, RunSnapshot } from "./conversation.js";
import { DEFAULT_SUBAGENT_UI_SETTINGS, type SubagentDisplaySettings, type SubagentSettings, type SubagentUiSettings, type WidgetMode } from "./settings.js";

export interface ProgressWidgetRow {
  conversation: ConversationSnapshot;
  run: RunSnapshot;
  status: "queued" | "running";
  text: string;
}

function activeRun(conversation: ConversationSnapshot): RunSnapshot | undefined {
  const run = conversation.currentRun;
  return run?.status.kind === "queued" || run?.status.kind === "running" ? run : undefined;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function latestActivity(run: RunSnapshot): string {
  const tool = [...run.activity.toolHistory].reverse().find(candidate => candidate.completedAt === undefined);
  if (tool) return `${tool.name}${tool.inputSummary ? ` ${tool.inputSummary}` : ""}`;
  if (run.activity.messageSnippet?.trim()) return run.activity.messageSnippet.replace(/\s+/g, " ").trim();
  const completedTool = [...run.activity.toolHistory].reverse().find(candidate => candidate.completedAt !== undefined);
  if (completedTool) return `${completedTool.name}${completedTool.inputSummary ? ` ${completedTool.inputSummary}` : ""}`;
  return "starting…";
}

export function formatProgressWidgetRow(conversation: ConversationSnapshot, run: RunSnapshot, now = Date.now()): ProgressWidgetRow {
  const status = run.status.kind;
  if (status !== "queued" && status !== "running") throw new Error("Progress rows require an active run.");
  const identity = conversation.label ?? conversation.config.name;
  const agent = conversation.label ? ` · ${conversation.config.name}` : "";
  const timestamp = status === "queued" ? run.status.queuedAt : run.status.startedAt;
  const marker = status === "running" ? "●" : "○";
  return {
    conversation,
    run,
    status,
    text: `${marker} ${identity}${agent} · ${status} ${formatElapsed(now - timestamp)} · ${latestActivity(run)}`,
  };
}

export function buildProgressWidgetRows(conversations: readonly ConversationSnapshot[], now = Date.now()): ProgressWidgetRow[] {
  return conversations.flatMap(conversation => {
    const run = activeRun(conversation);
    return run ? [formatProgressWidgetRow(conversation, run, now)] : [];
  });
}

export function formatSummaryWidgetLines(conversations: readonly ConversationSnapshot[]): string[] {
  if (!conversations.length) return [];
  const running = conversations.filter(conversation => conversation.currentRun?.status.kind === "running").length;
  const queued = conversations.filter(conversation => conversation.currentRun?.status.kind === "queued").length;
  const counts = [
    ...(running ? [`${running} running`] : []),
    ...(queued ? [`${queued} queued`] : []),
    `${conversations.length} retained`,
  ];
  return [`Subagents  ${counts.join(" · ")}`];
}

function limitProgressRows(rows: readonly ProgressWidgetRow[], display?: SubagentDisplaySettings) {
  const limit = display?.widgetMaxRowsPerSection ?? Infinity;
  return {
    visible: rows.slice(0, limit),
    overflow: Math.max(0, rows.length - limit),
  };
}

export function formatProgressWidgetLines(
  conversations: readonly ConversationSnapshot[],
  now = Date.now(),
  display?: SubagentDisplaySettings,
): string[] {
  const { visible, overflow } = limitProgressRows(buildProgressWidgetRows(conversations, now), display);
  return [...visible.map(row => row.text), ...(overflow ? [`+${overflow} more`] : [])];
}

export function formatWidgetLines(
  conversations: readonly ConversationSnapshot[],
  now = Date.now(),
  display?: SubagentDisplaySettings,
  mode: WidgetMode = "summary",
): string[] {
  return mode === "progress" ? formatProgressWidgetLines(conversations, now, display) : formatSummaryWidgetLines(conversations);
}

function formatThemedWidgetLine(line: string, status: ProgressWidgetRow["status"] | undefined, theme?: Pick<Theme, "fg">): string {
  const color: ThemeColor = status === "running" ? "accent" : status === "queued" ? "warning" : "muted";
  return theme?.fg ? theme.fg(color, line) : line;
}

export class SubagentWidgetComponent implements Component {
  private readonly timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly conversations: readonly ConversationSnapshot[],
    private readonly display: SubagentDisplaySettings | undefined,
    private readonly mode: WidgetMode,
    private readonly theme?: Theme,
    tui?: TUI,
  ) {
    if (mode === "progress" && buildProgressWidgetRows(conversations).length && tui?.requestRender) {
      this.timer = setInterval(() => tui.requestRender(), 1_000);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  invalidate(): void { }

  render(width: number): string[] {
    const now = Date.now();
    const { visible: progressRows, overflow } = this.mode === "progress"
      ? limitProgressRows(buildProgressWidgetRows(this.conversations, now), this.display)
      : { visible: [], overflow: 0 };
    const lines = this.mode === "progress"
      ? [
        ...progressRows.map(row => formatThemedWidgetLine(row.text, row.status, this.theme)),
        ...(overflow ? [formatThemedWidgetLine(`+${overflow} more`, undefined, this.theme)] : []),
      ]
      : formatSummaryWidgetLines(this.conversations).map(line => formatThemedWidgetLine(line, undefined, this.theme));
    return lines.map(line => truncateToWidth(line, Math.max(1, width), "…"));
  }
}

type WidgetComponentFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

type SubagentWidgetContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    setWidget?: {
      (id: string, content: string[] | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
      (id: string, content: WidgetComponentFactory | undefined, options?: { placement?: "belowEditor" | "aboveEditor" }): void;
    };
  };
};

type SubagentWidgetLifecyclePi = {
  on?(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: SubagentWidgetContext) => void): void;
};

type SubagentWidgetConversationSource = {
  listConversations(): ConversationSnapshot[];
  onConversationUpdate?(listener: (conversation: unknown, kind?: ConversationUpdateKind) => void): () => void;
};

export function registerSubagentWidgetLifecycle(
  pi: SubagentWidgetLifecyclePi,
  source: SubagentWidgetConversationSource,
  getSettings: () => SubagentSettings | SubagentUiSettings,
): void {
  if (typeof pi.on !== "function") return;
  let activeContext: SubagentWidgetContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let pendingRefresh: ReturnType<typeof setTimeout> | undefined;
  const clearPendingRefresh = () => {
    if (pendingRefresh) clearTimeout(pendingRefresh);
    pendingRefresh = undefined;
  };
  const refresh = () => { if (activeContext) updateSubagentWidget(activeContext, source.listConversations(), getSettings()); };
  const onConversationUpdate = (_conversation: unknown, kind?: ConversationUpdateKind) => {
    if (!activeContext) return;
    if (kind === "status" || kind === undefined) {
      clearPendingRefresh();
      refresh();
      return;
    }
    if (!pendingRefresh) pendingRefresh = setTimeout(() => {
      pendingRefresh = undefined;
      refresh();
    }, 100);
  };
  const subscribe = () => { unsubscribe ??= source.onConversationUpdate?.(onConversationUpdate); };
  subscribe();
  pi.on("session_shutdown", (_event, ctx) => {
    activeContext = undefined;
    clearPendingRefresh();
    unsubscribe?.();
    unsubscribe = undefined;
    updateSubagentWidget(ctx, [], getSettings());
  });
  pi.on("session_start", (_event, ctx) => { subscribe(); activeContext = ctx; refresh(); });
}

export function updateSubagentWidget(
  ctx: SubagentWidgetContext,
  conversations: ConversationSnapshot[],
  settings: SubagentSettings | SubagentUiSettings,
): void {
  if (!ctx.hasUI || !ctx.ui?.setWidget) return;
  try {
    if (settings.widgetPlacement === "off") {
      ctx.ui.setWidget("subagent", undefined);
      return;
    }
    const display = (settings as SubagentSettings).display;
    const mode = settings.widgetMode ?? DEFAULT_SUBAGENT_UI_SETTINGS.widgetMode;
    const hasContent = mode === "summary" ? conversations.length > 0 : buildProgressWidgetRows(conversations).length > 0;
    const factory: WidgetComponentFactory | undefined = hasContent
      ? (tui, theme) => new SubagentWidgetComponent(conversations, display, mode, theme, tui)
      : undefined;
    ctx.ui.setWidget("subagent", factory, { placement: settings.widgetPlacement });
  } catch (error) {
    try {
      ctx.ui.notify?.(`Subagent UI update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } catch { }
  }
}
