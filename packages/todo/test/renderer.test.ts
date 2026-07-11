import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { renderResult } from "../src/renderer.js";

const details = {
  state: {
    phases: [
      { name: "Planning", tasks: [{ id: "one", content: "Plan a very long release announcement", status: "pending" }] },
      { name: "Build", tasks: [
        { id: "two", content: "Implement renderer", status: "in_progress" },
        { id: "three", content: "Publish package", status: "completed" },
      ] },
    ],
  },
  changedTaskIds: ["two"],
} as never;

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => `*${text}*` };

describe("todo renderer", () => {
  it("renders collapsed counts and active work", () => {
    const collapsed = renderResult({ details }, { expanded: false }, plainTheme).render(80).join("\n").trim();
    expect(collapsed).toContain("Todo · 2 open · 1 completed");
    expect(collapsed).toContain("Active: 󰻃 Implement renderer");
    expect(collapsed).toContain("↵ expand");
  });

  it("renders phases, statuses, and changed task emphasis when expanded", () => {
    const text = renderResult({ details }, { expanded: true }, plainTheme).render(80).join("\n");
    expect(text).toContain("1. Planning · 0/1 completed");
    expect(text).toContain("󰄰 [one] Plan a very long release announcement");
    expect(text).toContain("2. Build · 1/2 completed");
    expect(text).toContain("*  󰻃 [two] Implement renderer*");
    expect(text).toContain("󰄴 [three] Publish package");
  });

  it("uses Text wrapping safely at narrow widths and handles empty state", () => {
    const lines = renderResult({ details }, { expanded: true }, plainTheme).render(12);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every(line => visibleWidth(line) <= 12)).toBe(true);
    expect(renderResult({ details: { state: { phases: [] } } as never }, {}, plainTheme).render(40)).toHaveLength(1);
  });

  it("colors and strikes through task statuses", () => {
    const themed = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
      strikethrough: (text: string) => `~${text}~`,
    };
    const text = renderResult({ details: {
      state: { phases: [{ name: "Tasks", tasks: [
        { id: "pending", content: "Pending", status: "pending" },
        { id: "active", content: "Active", status: "in_progress" },
        { id: "done", content: "Done", status: "completed" },
        { id: "cancelled", content: "Cancelled", status: "cancelled" },
      ] }] },
    } as never }, { expanded: true }, themed, { fallbackGlyphs: true }).render(80).join("\n");
    expect(text).toContain("<dim>  ○ [pending] Pending</dim>");
    expect(text).toContain("<text>  ▶ [active] Active</text>");
    expect(text).toContain("<success>  ✓ [done] ~Done~</success>");
    expect(text).toContain("<dim>  × [cancelled] ~Cancelled~</dim>");
  });
});
