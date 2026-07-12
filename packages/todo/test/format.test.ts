import { describe, expect, it } from "vitest";
import { countTodos, formatTodoSummary, formatTodoTaskLines } from "../src/format.js";
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
    expect(countTodos(state)).toEqual({ open: 2, completed: 1, cancelled: 1 });
  });
});
