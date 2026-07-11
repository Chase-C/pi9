import { describe, expect, it } from "vitest";

import { countTodos, formatTodoSummary, formatTodoTaskLines } from "../src/format.js";

const state = {
  phases: [
    { name: "Planning", tasks: [
      { id: "one", content: "Plan release", status: "pending" },
      { id: "four", content: "Old approach", status: "cancelled" },
    ] },
    { name: "Build", tasks: [
      { id: "two", content: "Build feature", status: "in_progress" },
      { id: "three", content: "Ship release", status: "completed" },
    ] },
  ],
} as never;

describe("todo formatting", () => {
  it("includes every status marker and task identity in the compact summary", () => {
    const summary = formatTodoSummary(state);
    expect(summary).toMatch(/○ \[one\] Plan release/);
    expect(summary).toMatch(/× \[four\] Old approach/);
    expect(summary).toMatch(/▶ \[two\] Build feature/);
    expect(summary).toMatch(/✓ \[three\] Ship release/);
  });

  it("handles empty state and counts non-completed statuses as open", () => {
    expect(formatTodoTaskLines({ phases: [] } as never)).toHaveLength(0);
    expect(countTodos(state)).toEqual({ open: 2, completed: 1, cancelled: 1 });
  });
});
