import { describe, expect, it } from "vitest";
import { renderResult } from "../src/renderer.js";
import type { TodoToolDetails } from "../src/types.js";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
};

const details: TodoToolDetails = {
  action: "transition",
  state: { phases: [
    { name: "Planning", tasks: [{ name: "Plan release announcement", status: "pending" }] },
    { name: "Build", tasks: [
      { name: "Implement renderer", status: "in_progress" },
      { name: "Publish package", status: "completed" },
    ] },
  ] },
  changedTasks: [{ phase: "Build", task: "Implement renderer" }],
};

describe("todo renderer", () => {
  it("renders compact counts, active work, and expansion hint", () => {
    const collapsed = renderResult({ details }, { expanded: false }, plainTheme).render(120).join("\n");
    expect(collapsed).toContain("2 open");
    expect(collapsed).toContain("1 completed");
    expect(collapsed).toContain("Implement renderer");
    expect(collapsed).toContain("↵ expand");
  });

  it("renders phases, statuses, and changed task emphasis without IDs", () => {
    const text = renderResult({ details }, { expanded: true }, plainTheme).render(120).join("\n");
    expect(text).toContain("*Todos · 1 active · 1 pending · 1 completed*");
    expect(text).toContain("1. Planning · 1 pending");
    expect(text).toContain("󰄰 Plan release announcement");
    expect(text).toContain("*  2. Build · 1 active · 1 completed*");
    expect(text).toContain("*    󰻃 Implement renderer*");
    expect(text).toContain("󰄴 Publish package");
    expect(text).not.toContain("[task-");
  });

  it("keeps every phase and orders active, pending, then terminal tasks", () => {
    const expanded = renderResult({ details: {
      action: "view",
      state: { phases: [
        { name: "Plan", tasks: [
          { name: "Done first", status: "completed" },
          { name: "Pending first", status: "pending" },
          { name: "Active", status: "in_progress" },
          { name: "Pending second", status: "pending" },
          { name: "Cancelled", status: "cancelled" },
        ] },
        { name: "Review", tasks: [{ name: "Review pending", status: "pending" }] },
        { name: "Empty", tasks: [] },
      ] },
      changedTasks: [],
    } }, { expanded: true }, plainTheme, { fallbackGlyphs: true }).render(120).join("\n");

    expect(expanded.indexOf("Active")).toBeLessThan(expanded.indexOf("Pending first"));
    expect(expanded.indexOf("Pending first")).toBeLessThan(expanded.indexOf("Done first"));
    expect(expanded).toContain("3. Empty");
  });

  it("uses fallback glyphs and terminal styling", () => {
    const themed = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
      strikethrough: (text: string) => `~${text}~`,
    };
    const text = renderResult({ details: {
      action: "view",
      state: { phases: [{ name: "Tasks", tasks: [
        { name: "Pending", status: "pending" },
        { name: "Active", status: "in_progress" },
        { name: "Done", status: "completed" },
        { name: "Cancelled", status: "cancelled" },
      ] }] },
      changedTasks: [],
    } }, { expanded: true }, themed, { fallbackGlyphs: true }).render(80).join("\n");
    expect(text).toContain("<dim>    ○ Pending</dim>");
    expect(text).toContain("<text>    ▶ Active</text>");
    expect(text).toContain("<success>    ✓ ~Done~</success>");
    expect(text).toContain("<dim>    × ~Cancelled~</dim>");
  });

  it("handles narrow and empty states safely", () => {
    expect(renderResult({ details }, { expanded: true }, plainTheme).render(12).length).toBeGreaterThan(3);
    const empty: TodoToolDetails = { action: "view", state: { phases: [] }, changedTasks: [] };
    expect(renderResult({ details: empty }, { expanded: true }, plainTheme).render(80).join("\n")).toContain("No todo tasks");
  });
});
