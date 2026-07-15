export interface FocusRange {
  /** Inclusive absolute row index in the full logical row list. */
  start: number;
  /** Exclusive absolute row index in the full logical row list. */
  end: number;
}

export type ViewportOverflow = "above" | "below" | "both";

export interface ViewportRow<T> {
  value: T;
  overflow?: ViewportOverflow;
}

/**
 * Fit logical rows into a terminal-height viewport.
 *
 * Fixed rows are taken from the beginning and end of `rows`. The rows between
 * them form the scrollable region. Overflow is metadata on boundary rows, so
 * it never consumes an additional terminal row.
 *
 * If the viewport is smaller than the fixed chrome, the first top row wins a
 * one-row viewport. With two or more rows, at least one row from each fixed
 * edge is retained, then remaining space is assigned to the top edge first.
 */
export function fitViewport<T>(
  rows: readonly T[],
  focus: FocusRange | undefined,
  maxRows: number,
  fixedTopRows: number,
  fixedBottomRows: number,
): ViewportRow<T>[] {
  const limit = rowLimit(maxRows, rows.length);
  if (limit === 0 || rows.length === 0) return [];

  if (rows.length <= limit) return rows.map(value => ({ value }));

  const topSize = fixedSize(fixedTopRows, rows.length);
  const bottomSize = fixedSize(fixedBottomRows, rows.length - topSize);
  const middleStart = topSize;
  const middleEnd = rows.length - bottomSize;
  const chromeSize = topSize + bottomSize;

  if (limit < chromeSize) {
    const { topVisible, bottomVisible } = degradedChrome(limit, topSize, bottomSize);
    return [
      ...rows.slice(0, topVisible),
      ...rows.slice(rows.length - bottomVisible),
    ].map(value => ({ value }));
  }

  const middleCapacity = limit - chromeSize;
  const middleSize = middleEnd - middleStart;
  const visibleCount = Math.min(middleCapacity, middleSize);
  const windowStart = chooseWindowStart(
    focus,
    rows.length,
    middleStart,
    middleEnd,
    visibleCount,
  );
  const hiddenAbove = windowStart > middleStart;
  const hiddenBelow = windowStart + visibleCount < middleEnd;
  const middle = rows
    .slice(windowStart, windowStart + visibleCount)
    .map(value => ({ value } as ViewportRow<T>));

  markOverflow(middle, hiddenAbove, hiddenBelow);

  return [
    ...rows.slice(0, topSize).map(value => ({ value })),
    ...middle,
    ...rows.slice(middleEnd).map(value => ({ value })),
  ];
}

function rowLimit(value: number, contentLength: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value)) return contentLength;
  return Math.floor(value);
}

function fixedSize(value: number, available: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value)) return available;
  return Math.min(Math.floor(value), available);
}

function degradedChrome(
  limit: number,
  topSize: number,
  bottomSize: number,
): { topVisible: number; bottomVisible: number } {
  if (topSize === 0) return { topVisible: 0, bottomVisible: Math.min(limit, bottomSize) };
  if (bottomSize === 0 || limit === 1) {
    return { topVisible: Math.min(limit, topSize), bottomVisible: 0 };
  }

  const topVisible = Math.min(topSize, limit - 1);
  const bottomVisible = Math.min(bottomSize, limit - topVisible);
  return { topVisible, bottomVisible };
}

function chooseWindowStart(
  focus: FocusRange | undefined,
  rowCount: number,
  middleStart: number,
  middleEnd: number,
  visibleCount: number,
): number {
  const latestStart = middleEnd - visibleCount;
  const range = normalizeFocus(focus, rowCount);
  if (!range) return middleStart;

  if (range.end <= middleStart) return middleStart;
  if (range.start >= middleEnd) return latestStart;

  const focusStart = Math.max(range.start, middleStart);
  const focusEnd = Math.min(range.end, middleEnd);
  const focusSize = focusEnd - focusStart;
  if (focusSize <= 0) return middleStart;
  if (focusSize >= visibleCount) return Math.min(focusStart, latestStart);

  const contextBefore = Math.floor((visibleCount - focusSize) / 2);
  return Math.max(middleStart, Math.min(focusStart - contextBefore, latestStart));
}

function normalizeFocus(focus: FocusRange | undefined, rowCount: number): FocusRange | undefined {
  if (!focus || !Number.isFinite(focus.start) || !Number.isFinite(focus.end)) return undefined;
  const start = Math.max(0, Math.min(Math.floor(focus.start), rowCount));
  const end = Math.max(0, Math.min(Math.floor(focus.end), rowCount));
  if (end <= start) return undefined;
  return { start, end };
}

function markOverflow<T>(
  middle: ViewportRow<T>[],
  hiddenAbove: boolean,
  hiddenBelow: boolean,
): void {
  if (middle.length === 0) return;
  if (middle.length === 1 && hiddenAbove && hiddenBelow) {
    middle[0]!.overflow = "both";
    return;
  }
  if (hiddenAbove) middle[0]!.overflow = "above";
  if (hiddenBelow) middle[middle.length - 1]!.overflow = "below";
}
