import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export type TodoToolFrameState = "pending" | "success" | "error";
export type TodoToolFrameContent = Component | string | readonly (Component | string)[] | null | undefined;
export type TodoToolFrameTheme = Partial<Pick<Theme, "fg" | "bg" | "bold">>;

export interface TodoToolFrameOptions {
  title?: string;
  action?: string;
  state?: TodoToolFrameState;
  content?: TodoToolFrameContent;
  paddingX?: number;
  paddingY?: number;
  empty?: "hide" | "frame";
}

type FrameColor = Parameters<Theme["fg"]>[0];
type FrameBackground = Parameters<Theme["bg"]>[0];

type FrameStyle = {
  state: FrameColor;
  background: FrameBackground;
  marker: string;
};

const FRAME_STYLES: Record<TodoToolFrameState, FrameStyle> = {
  pending: {
    state: "warning",
    background: "toolPendingBg",
    marker: "●",
  },
  success: {
    state: "success",
    background: "toolSuccessBg",
    marker: "✓",
  },
  error: {
    state: "error",
    background: "toolErrorBg",
    marker: "✗",
  },
};

const DEFAULT_TITLE = "todo";

export class TodoToolFrame implements Component {
  constructor(
    private readonly options: TodoToolFrameOptions,
    private readonly theme?: TodoToolFrameTheme,
  ) {}

  invalidate(): void {
    for (const entry of contentEntries(this.options.content)) {
      if (typeof entry !== "string") entry.invalidate();
    }
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    const paddingX = normalizePadding(this.options.paddingX, 1);
    const paddingY = normalizePadding(this.options.paddingY, 1);
    const contentWidth = Math.max(1, safeWidth - paddingX * 2);
    const content = this.options.content;
    const hasContent = hasRenderableContent(content, contentWidth);

    if (!hasContent && this.options.empty !== "frame") return [];

    const state = this.options.state ?? "pending";
    const style = FRAME_STYLES[state];
    const boxPaddingX = Math.min(paddingX, Math.floor(safeWidth / 2));
    const box = new Box(
      boxPaddingX,
      paddingY,
      this.theme?.bg
        ? (text: string) => this.theme!.bg!(style.background, text)
        : undefined,
    );

    box.addChild(new Text(this.renderHeader(state, style), 0, 0));
    if (hasContent) {
      for (const entry of contentEntries(content)) {
        box.addChild(typeof entry === "string"
          ? new Text(this.paint("toolOutput", entry), 0, 0)
          : entry);
      }
    }

    return box.render(safeWidth);
  }

  private renderHeader(state: TodoToolFrameState, style: FrameStyle): string {
    const title = normalizeLabel(this.options.title === undefined ? DEFAULT_TITLE : this.options.title);
    const action = normalizeLabel(this.options.action);
    const label = [title ? this.paint("toolTitle", this.bold(title)) : "", action ? this.paint("muted", action) : ""]
      .filter(Boolean)
      .join(" ");
    const marker = this.paint(style.state, `${style.marker} ${state}`);
    return [label, marker].filter(Boolean).join("  ");
  }

  private paint(color: FrameColor, text: string): string {
    return this.theme?.fg ? this.theme.fg(color, text) : text;
  }

  private bold(text: string): string {
    return this.theme?.bold ? this.theme.bold(text) : text;
  }

}

function normalizeWidth(width: number): number {
  return Math.max(1, Math.floor(width) || 1);
}

function normalizePadding(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeLabel(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function contentEntries(content: TodoToolFrameContent): readonly (Component | string)[] {
  if (content === null || content === undefined) return [];
  if (Array.isArray(content)) return content as readonly (Component | string)[];
  return [content as Component | string];
}

function hasRenderableContent(content: TodoToolFrameContent, width: number): boolean {
  return contentEntries(content).some((entry) => {
    if (typeof entry === "string") return entry.trim().length > 0;
    return entry.render(width).length > 0;
  });
}
