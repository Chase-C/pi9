import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { WidgetLayout } from "../config/settings.js";

/** Minimum visible width per side-by-side column (~34 cols each). */
export const WIDGET_COLUMNS_MIN_COLUMN_WIDTH = 34;
export const WIDGET_COLUMN_GUTTER = " | ";
export const WIDGET_COLUMNS_BREAKPOINT =
  WIDGET_COLUMNS_MIN_COLUMN_WIDTH * 2 + visibleWidth(WIDGET_COLUMN_GUTTER);

export function hasBothColumnSections(sections: readonly { title: string }[]): boolean {
  let hasBackground = false;
  let hasResumable = false;
  for (const section of sections) {
    if (section.title === "Background") hasBackground = true;
    else if (section.title === "Resumable") hasResumable = true;
    if (hasBackground && hasResumable) return true;
  }
  return false;
}

export function resolveWidgetLayout(
  layout: WidgetLayout,
  width: number,
  bothColumnSectionsPresent = true,
): "columns" | "stacked" {
  if (layout === "columns") return "columns";
  if (layout === "stacked") return "stacked";
  if (!bothColumnSectionsPresent) return "stacked";
  return width >= WIDGET_COLUMNS_BREAKPOINT ? "columns" : "stacked";
}

export function widgetColumnWidths(totalWidth: number): { left: number; right: number } {
  const gutterWidth = visibleWidth(WIDGET_COLUMN_GUTTER);
  const remaining = Math.max(1, totalWidth - gutterWidth);
  const left = Math.floor(remaining / 2);
  return { left, right: remaining - left };
}

export function zipWidgetColumns(
  leftLines: string[],
  rightLines: string[],
  leftWidth: number,
  gutter: string,
  rightWidth = leftWidth,
): string[] {
  const maxLen = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const left = truncateToWidth(leftLines[i] ?? "", leftWidth, "", true);
    const right = truncateToWidth(rightLines[i] ?? "", rightWidth, "", true);
    lines.push(`${left}${gutter}${right}`);
  }
  return lines;
}
