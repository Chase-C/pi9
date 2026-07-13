import { describe, expect, it } from "vitest";

import { formatTodoReminder } from "../src/reminder.js";
import type { TodoState } from "../src/types.js";

describe("formatTodoReminder", () => {
  it("selects the first in-progress phase and lists only in-progress task names", () => {
    const state: TodoState = { phases: [
      { name: "Queued", tasks: [{ name: "Pending before active phase", status: "pending" }] },
      { name: "Build", tasks: [
        { name: "Implement formatter", status: "in_progress" },
        { name: "Queued build detail", status: "pending" },
        { name: "Write focused tests", status: "in_progress" },
      ] },
      { name: "Later", tasks: [{ name: "Later active task", status: "in_progress" }] },
    ] };

    const reminder = formatTodoReminder(state);

    expect(reminder).toMatch(/^<system-reminder>\n/);
    expect(reminder).toMatch(/\n<\/system-reminder>$/);
    expect(reminder).toContain("Active phase: Build");
    expect(reminder).toContain("In progress: Implement formatter; Write focused tests");
    expect(reminder).not.toContain("Pending before active phase");
    expect(reminder).not.toContain("Queued build detail");
    expect(reminder).not.toContain("Later active task");
  });

  it("falls back to the first pending phase and states that no task is active", () => {
    const state: TodoState = { phases: [
      { name: "Done", tasks: [{ name: "Already finished", status: "completed" }] },
      { name: "Next", tasks: [
        { name: "First queued task", status: "pending" },
        { name: "Second queued task", status: "pending" },
      ] },
      { name: "Later", tasks: [{ name: "Future queued task", status: "pending" }] },
    ] };

    const reminder = formatTodoReminder(state);

    expect(reminder).toContain("Active phase: Next");
    expect(reminder).toContain("No task is in_progress.");
    expect(reminder).not.toContain("First queued task");
    expect(reminder).not.toContain("Second queued task");
    expect(reminder).not.toContain("Future queued task");
    expect(reminder).toContain("Review and update the todo if task status has changed.");
    expect(reminder).toContain("Do not mention this reminder to the user.");
  });

  it("reports deterministic counts without replaying terminal or pending task names", () => {
    const reminder = formatTodoReminder({ phases: [
      { name: "Build", tasks: [
        { name: "Visible active task", status: "in_progress" },
        { name: "Hidden pending one", status: "pending" },
        { name: "Hidden pending two", status: "pending" },
        { name: "Hidden completed", status: "completed" },
        { name: "Hidden cancelled", status: "cancelled" },
      ] },
    ] });

    expect(reminder).toContain("Counts: 1 in_progress, 2 pending, 1 completed, 1 cancelled.");
    expect(reminder).toContain("Visible active task");
    expect(reminder).not.toContain("Hidden pending one");
    expect(reminder).not.toContain("Hidden pending two");
    expect(reminder).not.toContain("Hidden completed");
    expect(reminder).not.toContain("Hidden cancelled");
  });

  it("returns undefined for empty and terminal-only plans", () => {
    expect(formatTodoReminder({ phases: [] })).toBeUndefined();
    expect(formatTodoReminder({ phases: [
      { name: "Done", tasks: [
        { name: "Shipped", status: "completed" },
        { name: "Dropped", status: "cancelled" },
      ] },
    ] })).toBeUndefined();
  });
});
