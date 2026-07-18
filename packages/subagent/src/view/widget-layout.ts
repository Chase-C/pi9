import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { WidgetLayout } from "../config/settings.js";

export const WIDGET_COLUMN_GUTTER = "  │ ";

export function maxLineWidth(lines: readonly string[]): number {
  let max = 0;
  for (const line of lines) {
    max = Math.max(max, visibleWidth(line));
  }
  return max;
}

export function hasBothColumnSections(sections: readonly { title: string }[]): boolean {
  let hasActive = false;
  let hasCompleted = false;
  for (const section of sections) {
    if (section.title === "Active Runs") hasActive = true;
    else if (section.title === "Completed Runs") hasCompleted = true;
    if (hasActive && hasCompleted) return true;
  }
  return false;
}

export function resolveWidgetLayout(
  layout: WidgetLayout,
  width: number,
  bothColumnSectionsPresent = true,
  leftNaturalWidth = 0,
): "columns" | "stacked" {
  if (layout === "columns") return "columns";
  if (layout === "stacked") return "stacked";
  if (!bothColumnSectionsPresent) return "stacked";
  return width > leftNaturalWidth + visibleWidth(WIDGET_COLUMN_GUTTER) ? "columns" : "stacked";
}

export function zipWidgetColumns(
  leftLines: string[],
  rightLines: string[],
  totalWidth: number,
  gutter: string = WIDGET_COLUMN_GUTTER,
): string[] {
  const gutterWidth = visibleWidth(gutter);
  const leftWidth = Math.min(maxLineWidth(leftLines), Math.max(0, totalWidth - gutterWidth));
  const rightWidth = Math.max(0, totalWidth - leftWidth - gutterWidth);
  const maxLen = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const left = truncateToWidth(leftLines[i] ?? "", leftWidth, "", true);
    const right = truncateToWidth(rightLines[i] ?? "", rightWidth, "", false);
    lines.push(`${left}${gutter}${right}`);
  }
  return lines;
}
