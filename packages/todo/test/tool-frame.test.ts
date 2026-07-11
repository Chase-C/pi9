import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { TodoToolFrame, type TodoToolFrameTheme } from "../src/tool-frame.js";

type ThemeCall = { kind: "fg" | "bg" | "bold"; color?: string };

function recordingTheme(calls: ThemeCall[]): TodoToolFrameTheme {
  return {
    fg(color, text) {
      calls.push({ kind: "fg", color });
      return text;
    },
    bg(color, text) {
      calls.push({ kind: "bg", color });
      return text;
    },
    bold(text) {
      calls.push({ kind: "bold" });
      return text;
    },
  };
}

function assertWidth(lines: readonly string[], width: number): void {
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
}

const componentContent: Component = {
  invalidate() { },
  render() {
    return ["component content"];
  },
};

describe("TodoToolFrame", () => {
  it("renders a native-style title/action shell and preserves component content", () => {
    const calls: ThemeCall[] = [];
    const frame = new TodoToolFrame({
      title: "todo",
      action: "plan",
      state: "pending",
      content: componentContent,
    }, recordingTheme(calls));

    const lines = frame.render(32);
    const output = lines.join("\n");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0].trim()).toBe("");
    expect(lines.at(-1)?.trim()).toBe("");
    expect(output).toContain("todo");
    expect(output).toContain("plan");
    expect(output).toContain("pending");
    expect(output).toContain("component content");
    expect(output).not.toMatch(/[\u2500-\u257f]/);
    assertWidth(lines, 32);
    expect(calls).toEqual(expect.arrayContaining([
      { kind: "fg", color: "toolTitle" },
      { kind: "fg", color: "muted" },
      { kind: "fg", color: "warning" },
      { kind: "bg", color: "toolPendingBg" },
    ]));
    expect(calls).not.toEqual(expect.arrayContaining([
      { kind: "fg", color: "borderMuted" },
    ]));
  });

  it("uses native background callbacks for each state without changing content", () => {
    for (const [state, background, foreground] of [
      ["pending", "toolPendingBg", "warning"],
      ["success", "toolSuccessBg", "success"],
      ["error", "toolErrorBg", "error"],
    ] as const) {
      const calls: ThemeCall[] = [];
      const frame = new TodoToolFrame({ title: "todo", action: "update", state, content: "keep this" }, recordingTheme(calls));
      const lines = frame.render(40);
      const output = lines.join("\n");

      expect(output).toContain("keep this");
      expect(output).toContain(state);
      expect(calls).toEqual(expect.arrayContaining([
        { kind: "fg", color: foreground },
        { kind: "bg", color: background },
      ]));
      expect(calls).not.toEqual(expect.arrayContaining([
        { kind: "fg", color: "borderMuted" },
      ]));
    }
  });

  it("keeps every line within narrow and normal widths", () => {
    const frame = new TodoToolFrame({
      title: "todo",
      action: "long-action-name",
      content: "A deliberately long todo result that must wrap safely.",
    });

    for (const width of [1, 2, 3, 7, 12, 40, 80]) {
      const lines = frame.render(width);
      expect(lines.length).toBeGreaterThan(0);
      assertWidth(lines, width);
    }
    expect(frame.render(12).join("\n")).toContain("todo");
    expect(frame.render(40).join("\n")).toContain("deliberately long todo result");
  });

  it("hides empty content by default and can explicitly render an empty frame", () => {
    const hidden = new TodoToolFrame({ title: "todo", action: "view" });
    expect(hidden.render(24)).toHaveLength(0);

    const visible = new TodoToolFrame({ title: "todo", action: "view", empty: "frame" });
    const lines = visible.render(24);
    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    expect(output).toContain("todo");
    expect(output).toContain("view");
    expect(output).toContain("pending");
    expect(output).not.toMatch(/[\u2500-\u257f]/);
    assertWidth(lines, 24);
  });
});
