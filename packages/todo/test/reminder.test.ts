import { describe, expect, it } from "vitest";

import { formatTodoReminder } from "../src/reminder.js";
import type { TodoState } from "../src/types.js";
import { todo } from "./helpers.js";

describe("formatTodoReminder", () => {
  it("selects the first in-progress phase and describes its open tasks", () => {
    const state: TodoState = { phases: [
      { name: "Queued", tasks: [todo("Pending before active phase")] },
      { name: "Build", tasks: [
        todo("Implement formatter", "in_progress"),
        todo("Queued build detail"),
        todo("Write focused tests", "in_progress"),
      ] },
      { name: "Later", tasks: [todo("Later active task", "in_progress")] },
    ], workingOn: "Implementing and testing the formatter" };

    const reminder = formatTodoReminder(state);

    expect(reminder).toMatch(/^<system-reminder>\n/);
    expect(reminder).toMatch(/\n<\/system-reminder>$/);
    expect(reminder).toContain("Active phase: Build");
    expect(reminder).toContain("Current work: Implementing and testing the formatter");
    expect(reminder).toContain("Open tasks in this phase:\n- [in_progress] Implement formatter: Detailed description for Implement formatter.");
    expect(reminder).toContain("- [pending] Queued build detail: Detailed description for Queued build detail.");
    expect(reminder).toContain("- [in_progress] Write focused tests: Detailed description for Write focused tests.");
    expect(reminder).not.toContain("Pending before active phase");
    expect(reminder).not.toContain("Later active task");
  });

  it("falls back to the first pending phase and describes its queued tasks", () => {
    const state: TodoState = { phases: [
      { name: "Done", tasks: [todo("Already finished", "completed")] },
      { name: "Next", tasks: [todo("First queued task"), todo("Second queued task")] },
      { name: "Later", tasks: [todo("Future queued task")] },
    ] };

    const reminder = formatTodoReminder(state);

    expect(reminder).toContain("Active phase: Next");
    expect(reminder).toContain("- [pending] First queued task: Detailed description for First queued task.");
    expect(reminder).toContain("- [pending] Second queued task: Detailed description for Second queued task.");
    expect(reminder).not.toContain("Future queued task");
    expect(reminder).toContain("Review and update the todo if task status has changed.");
    expect(reminder).toContain("Do not mention this reminder to the user.");
  });

  it("reports deterministic counts and omits terminal task details", () => {
    const reminder = formatTodoReminder({ phases: [
      { name: "Build", tasks: [
        todo("Visible active task", "in_progress"),
        todo("Hidden pending one"),
        todo("Hidden pending two"),
        todo("Hidden completed", "completed"),
        todo("Hidden cancelled", "cancelled"),
      ] },
    ], workingOn: "Working on the visible task" });

    expect(reminder).toContain("Counts: 1 in_progress, 2 pending, 1 completed, 1 cancelled.");
    expect(reminder).toContain("Visible active task");
    expect(reminder).toContain("Hidden pending one");
    expect(reminder).toContain("Hidden pending two");
    expect(reminder).not.toContain("Hidden completed");
    expect(reminder).not.toContain("Hidden cancelled");
  });

  it("returns undefined for empty and terminal-only plans", () => {
    expect(formatTodoReminder({ phases: [] })).toBeUndefined();
    expect(formatTodoReminder({ phases: [
      { name: "Done", tasks: [
        todo("Shipped", "completed"),
        todo("Dropped", "cancelled"),
      ] },
    ] })).toBeUndefined();
  });
});
