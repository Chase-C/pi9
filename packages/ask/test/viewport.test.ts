import { describe, expect, it } from "vitest";

import { fitViewport, type ViewportOverflow, type ViewportRow } from "../src/viewport.js";

const lines = ["top", "middle 0", "middle 1", "middle 2", "middle 3", "middle 4", "bottom"];

function row<T>(value: T, overflow?: ViewportOverflow): ViewportRow<T> {
  return overflow ? { value, overflow } : { value };
}

function viewport(focus: { start: number; end: number } | undefined, maxRows = 5) {
  return fitViewport(lines, focus, maxRows, 1, 1);
}

describe("fitViewport", () => {
  it("returns fitting logical rows without changing their values", () => {
    const input = [{ text: "one" }, { text: "two" }, { text: "three" }];

    expect(fitViewport(input, { start: 1, end: 2 }, 3, 1, 1)).toEqual(input.map(value => row(value)));
  });

  it("keeps focus visible near the top, middle, and bottom", () => {
    expect(viewport({ start: 1, end: 2 })).toEqual([
      row("top"), row("middle 0"), row("middle 1"), row("middle 2", "below"), row("bottom"),
    ]);
    expect(viewport({ start: 3, end: 4 })).toEqual([
      row("top"), row("middle 1", "above"), row("middle 2"), row("middle 3", "below"), row("bottom"),
    ]);
    expect(viewport({ start: 5, end: 6 })).toEqual([
      row("top"), row("middle 2", "above"), row("middle 3"), row("middle 4"), row("bottom"),
    ]);
  });

  it("keeps an entire multi-row focus visible when it fits", () => {
    const result = fitViewport(lines, { start: 2, end: 5 }, 6, 1, 1);

    expect(result).toEqual([
      row("top"), row("middle 1", "above"), row("middle 2"), row("middle 3"), row("middle 4"), row("bottom"),
    ]);
  });

  it("shows the focus-leading portion when a multi-row focus is taller than the middle", () => {
    const result = viewport({ start: 2, end: 6 }, 4);

    expect(result).toEqual([
      row("top"), row("middle 1", "above"), row("middle 2", "below"), row("bottom"),
    ]);
  });

  it("marks only downward, only upward, and two-way overflow", () => {
    expect(viewport({ start: 1, end: 2 })[3]).toEqual(row("middle 2", "below"));
    expect(viewport({ start: 5, end: 6 })[1]).toEqual(row("middle 2", "above"));
    expect(viewport({ start: 3, end: 4 }).slice(1, 4)).toEqual([
      row("middle 1", "above"), row("middle 2"), row("middle 3", "below"),
    ]);
    expect(viewport({ start: 3, end: 4 }, 3)).toEqual([
      row("top"), row("middle 2", "both"), row("bottom"),
    ]);
  });

  it("does not interpret or modify string content", () => {
    const content = ["top", "↑ literal │ ANSI \u001b[31mred\u001b[0m", "↓ literal", "bottom"];

    expect(fitViewport(content, { start: 2, end: 3 }, 3, 1, 1)).toEqual([
      row("top"), row("↓ literal", "above"), row("bottom"),
    ]);
  });

  it("degrades tiny terminals deterministically, retaining both chrome edges when possible", () => {
    const chromeHeavy = ["top 0", "top 1", "middle", "bottom 0", "bottom 1"];

    expect(fitViewport(chromeHeavy, undefined, 3, 2, 2)).toEqual([
      row("top 0"), row("top 1"), row("bottom 1"),
    ]);
    expect(fitViewport(chromeHeavy, undefined, 2, 2, 2)).toEqual([row("top 0"), row("bottom 1")]);
    expect(fitViewport(chromeHeavy, undefined, 1, 2, 2)).toEqual([row("top 0")]);
    expect(fitViewport(chromeHeavy, undefined, 0, 2, 2)).toEqual([]);
    expect(fitViewport(chromeHeavy, undefined, -10, 2, 2)).toEqual([]);
    expect(fitViewport(chromeHeavy, undefined, Number.NaN, 2, 2)).toEqual([]);
  });

  it("never exceeds maxRows across viewport sizes", () => {
    for (const maxRows of [-3, 0, 1, 2, 3, 4, 5, 6, 7, 20]) {
      const result = fitViewport(lines, { start: 3, end: 6 }, maxRows, 1, 1);
      expect(result.length, `maxRows=${maxRows}`).toBeLessThanOrEqual(Math.max(0, maxRows));
    }
  });
});
