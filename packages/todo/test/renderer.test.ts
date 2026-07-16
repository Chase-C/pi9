import { describe, expect, it } from "vitest";
import { renderResult } from "../src/renderer.js";
import type { TodoToolDetails } from "../src/types.js";
import { todo } from "./helpers.js";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
};

const details: TodoToolDetails = {
  action: "transition",
  state: { phases: [
    { name: "Planning", tasks: [todo("Plan release announcement")] },
    { name: "Build", tasks: [
      todo("Implement renderer", "in_progress"),
      todo("Publish package", "completed"),
    ] },
  ], workingOn: "Implementing the renderer" },
  changedTasks: [{ phase: "Build", task: "Implement renderer" }],
};

describe("todo renderer", () => {
  it("renders compact phase and task totals without an expansion hint", () => {
    const collapsed = renderResult({ details }, { expanded: false }, plainTheme).render(120).join("\n").trimEnd();
    expect(collapsed).toBe("2 phases · 3 tasks");
    expect(collapsed).not.toContain("expand");
  });

  it("uses singular labels for one phase and task", () => {
    const single: TodoToolDetails = {
      action: "set",
      state: { phases: [{ name: "Build", tasks: [todo("Implement renderer")] }] },
      changedTasks: [],
    };
    expect(renderResult({ details: single }, { expanded: false }, plainTheme).render(80).join("\n").trimEnd())
      .toBe("1 phase · 1 task");
  });

  it("matches widget phase and task styling without a Todos header", () => {
    const themed = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => `<bold>${text}</bold>`,
    };
    const text = renderResult({ details }, { expanded: true }, themed).render(120).join("\n");
    expect(text).toContain("<muted>  1. Planning · 0/1</muted>");
    expect(text).toContain("<muted>    󰄰 Plan release announcement</muted>");
    expect(text).toContain("<toolTitle><bold>  2. Build</bold></toolTitle> <muted>· 1/2</muted>");
    expect(text).toContain("<muted>    󰻃</muted> <text>Implement renderer</text>");
    expect(text).toContain("<success>    󰄴 Publish package</success>");
    expect(text).not.toContain("Todos");
    expect(text).not.toContain("[task-");
  });

  it("keeps every phase and orders active, pending, then terminal tasks", () => {
    const expanded = renderResult({ details: {
      action: "view",
      state: { phases: [
        { name: "Plan", tasks: [
          todo("Done first", "completed"),
          todo("Pending first"),
          todo("Active", "in_progress"),
          todo("Pending second"),
          todo("Cancelled", "cancelled"),
        ] },
        { name: "Review", tasks: [todo("Review pending")] },
        { name: "Empty", tasks: [] },
      ], workingOn: "Handling the active task" },
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
        todo("Pending"),
        todo("Active", "in_progress"),
        todo("Done", "completed"),
        todo("Cancelled", "cancelled"),
      ] }], workingOn: "Handling the active task" },
      changedTasks: [],
    } }, { expanded: true }, themed, { fallbackGlyphs: true }).render(80).join("\n");
    expect(text).toContain("<toolTitle>  1. Tasks</toolTitle> <muted>· 2/4</muted>");
    expect(text).toContain("<muted>    ○ Pending</muted>");
    expect(text).toContain("<muted>    ▶</muted> <text>Active</text>");
    expect(text).toContain("<success>    ✓ ~Done~</success>");
    expect(text).toContain("<muted>    × ~Cancelled~</muted>");
  });

  it("handles narrow and empty states safely", () => {
    expect(renderResult({ details }, { expanded: true }, plainTheme).render(12).length).toBeGreaterThan(3);
    const empty: TodoToolDetails = { action: "view", state: { phases: [] }, changedTasks: [] };
    expect(renderResult({ details: empty }, { expanded: true }, plainTheme).render(80).join("\n")).toContain("No todo tasks");
  });
});
