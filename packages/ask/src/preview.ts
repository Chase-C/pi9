import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Terminal width at which an authored preview gets its own pane. */
export const PREVIEW_WIDE_THRESHOLD = 88;

export interface PreviewPaneLayout {
  leftWidth: number;
  rightWidth: number;
}

/**
 * Choose the option/preview pane sizes without allowing either pane to become
 * unusably narrow. The split is intentionally opt-in at a comfortable width.
 */
export function getPreviewPaneLayout(width: number): PreviewPaneLayout | undefined {
  const renderWidth = safeWidth(width);
  if (renderWidth < PREVIEW_WIDE_THRESHOLD) return undefined;

  const available = renderWidth - 1; // one column for the separator
  const leftWidth = Math.max(32, Math.floor(available * 0.4));
  const rightWidth = available - leftWidth;
  if (rightWidth < 40) return undefined;
  return { leftWidth, rightWidth };
}

/** Render authored option text using Pi's normal markdown theme. */
export function renderPreviewMarkdown(preview: string, width: number): string[] {
  if (!preview.trim()) return [];
  const lines = new Markdown(preview, 0, 0, getMarkdownTheme()).render(safeWidth(width));
  return lines.map(line => fitAndPad(line, safeWidth(width)));
}

/** Compose one visible option row with its corresponding preview row. */
export function composePreviewRow(
  left: string,
  preview: string,
  layout: PreviewPaneLayout,
  separator: string,
): string {
  return [
    fitAndPad(left, layout.leftWidth),
    fitAndPad(separator, 1),
    fitAndPad(preview, layout.rightWidth),
  ].join("");
}

function safeWidth(width: number): number {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1);
}

function fitAndPad(line: string, width: number): string {
  const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
