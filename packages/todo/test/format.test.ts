import { describe, expect, it } from "vitest";
import { countTodos, formatTodoCompactionContext, formatTodoSummary, formatTodoTaskLines, todoTasks } from "../src/format.js";
import type { TodoState } from "../src/types.js";

const state: TodoState = {
  phases: [
    { name: "Planning", tasks: [
      { name: "Plan release", status: "pending" },
      { name: "Cancel old approach", status: "cancelled" },
    ] },
    { name: "Build", tasks: [
      { name: "Build feature", status: "in_progress" },
      { name: "Ship release", status: "completed" },
    ] },
  ],
};

describe("todo formatting", () => {
  it("includes every status marker and canonical task name", () => {
    const summary = formatTodoSummary(state);
    expect(summary).toMatch(/○ Plan release/);
    expect(summary).toMatch(/× Cancel old approach/);
    expect(summary).toMatch(/▶ Build feature/);
    expect(summary).toMatch(/✓ Ship release/);
    expect(summary).not.toMatch(/task-/);
  });

  it("handles empty state and counts non-terminal statuses as open", () => {
    expect(formatTodoTaskLines({ phases: [] })).toHaveLength(0);
    expect(countTodos(todoTasks(state))).toEqual({ open: 2, completed: 1, cancelled: 1 });
  });

  it("formats an exact complete post-compaction context in phase and task order", () => {
    const completeState: TodoState = {
      phases: [
        state.phases[0],
        { name: "Empty phase", tasks: [] },
        state.phases[1],
      ],
    };

    expect(formatTodoCompactionContext(completeState)).toBe([
      "<system-reminder source=\"todo-post-compaction\">",
      "Todo plan after compaction:",
      "Planning:",
      "  [pending] Plan release",
      "  [cancelled] Cancel old approach",
      "Empty phase:",
      "  (no tasks)",
      "Build:",
      "  [in_progress] Build feature",
      "  [completed] Ship release",
      "Continue using this plan and keep task statuses current.",
      "Do not mention this reminder to the user.",
      "</system-reminder>",
    ].join("\n"));
  });

  it("returns no post-compaction context for zero tasks but includes terminal-only plans", () => {
    expect(formatTodoCompactionContext({ phases: [] })).toBeUndefined();
    expect(formatTodoCompactionContext({ phases: [
      { name: "Empty", tasks: [] },
      { name: "Done", tasks: [{ name: "Already shipped", status: "completed" }] },
    ] })).toContain("[completed] Already shipped");
  });
});
