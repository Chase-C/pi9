import { describe, expect, it } from "vitest";
import { countTodos, formatTodoCompactionContext, formatTodoSummary, formatTodoTaskLines, todoTasks } from "../src/format.js";
import type { TodoState } from "../src/types.js";
import { todo } from "./helpers.js";

const state: TodoState = {
  phases: [
    { name: "Planning", tasks: [
      todo("Plan release"),
      todo("Cancel old approach", "cancelled"),
    ] },
    { name: "Build", tasks: [
      todo("Build feature", "in_progress"),
      todo("Ship release", "completed"),
    ] },
  ],
  workingOn: "Building the feature",
};

describe("todo formatting", () => {
  it("includes every status marker and canonical task name", () => {
    const summary = formatTodoSummary(state);
    expect(summary).toMatch(/○ Plan release/);
    expect(summary).toMatch(/× Cancel old approach/);
    expect(summary).toMatch(/▶ Build feature/);
    expect(summary).toMatch(/✓ Ship release/);
    expect(summary).not.toContain("Detailed description");
    expect(formatTodoSummary(state, true)).toContain("Build feature — Detailed description for Build feature.");
    expect(formatTodoSummary(state, true)).toContain("Working on: Building the feature");
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
      workingOn: state.workingOn,
    };

    expect(formatTodoCompactionContext(completeState)).toBe([
      "<system-reminder source=\"todo-post-compaction\">",
      "Todo plan after compaction:",
      "Current work: Building the feature",
      "Planning:",
      "  [pending] Plan release: Detailed description for Plan release.",
      "  [cancelled] Cancel old approach: Detailed description for Cancel old approach.",
      "Empty phase:",
      "  (no tasks)",
      "Build:",
      "  [in_progress] Build feature: Detailed description for Build feature.",
      "  [completed] Ship release: Detailed description for Ship release.",
      "Continue using this plan and keep task statuses current.",
      "Do not mention this reminder to the user.",
      "</system-reminder>",
    ].join("\n"));
  });

  it("returns no post-compaction context for zero tasks but includes terminal-only plans", () => {
    expect(formatTodoCompactionContext({ phases: [] })).toBeUndefined();
    expect(formatTodoCompactionContext({ phases: [
      { name: "Empty", tasks: [] },
      { name: "Done", tasks: [todo("Already shipped", "completed")] },
    ] })).toContain("[completed] Already shipped");
  });
});
