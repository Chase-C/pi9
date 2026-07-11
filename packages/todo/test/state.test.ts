import { describe, expect, it } from "vitest";
import { createTodoState, transitionTodoState } from "../src/state.js";

describe("todo state", () => {
  it("assigns stable IDs and permits duplicate content and multiple in-progress tasks", () => {
    const first = transitionTodoState(createTodoState(), {
      action: "set",
      tasks: [{ content: "Same", status: "in_progress" }, { content: "Same", status: "in_progress" }],
    });
    expect(first.phases).toEqual([{ name: "Tasks", tasks: [
      { id: "task-1", content: "Same", status: "in_progress" },
      { id: "task-2", content: "Same", status: "in_progress" },
    ] }]);
    expect(first.nextId).toBe(3);
  });

  it("adds a batch to an existing or new named phase", () => {
    const first = transitionTodoState(createTodoState(), {
      action: "add", phase: "Build", tasks: [{ content: "Implement" }, { content: "Test", status: "in_progress" }],
    });
    const second = transitionTodoState(first, {
      action: "add", phase: "Build", tasks: [{ content: "Review" }],
    });
    expect(second.phases).toEqual([
      { name: "Tasks", tasks: [] },
      { name: "Build", tasks: [
        { id: "task-1", content: "Implement", status: "pending" },
        { id: "task-2", content: "Test", status: "in_progress" },
        { id: "task-3", content: "Review", status: "pending" },
      ] },
    ]);
  });

  it("rejects an empty add batch transactionally", () => {
    const state = createTodoState();
    expect(() => transitionTodoState(state, { action: "add", phase: "Build", tasks: [] })).toThrow(/at least one task/);
    expect(state).toEqual(createTodoState());
  });

  it("updates content, status, and phase without mutating its input", () => {
    const before = transitionTodoState(createTodoState(), {
      action: "set", phases: [{ name: "Tasks", tasks: [{ content: "A" }] }, { name: "Done", tasks: [] }],
    });
    const after = transitionTodoState(before, {
      action: "update", id: "task-1", content: "B", status: "completed", phase: "Done",
    });
    expect(before.phases[0].tasks).toHaveLength(1);
    expect(after.phases).toEqual([
      { name: "Tasks", tasks: [] },
      { name: "Done", tasks: [{ id: "task-1", content: "B", status: "completed" }] },
    ]);
  });

  it("rejects duplicate phase names transactionally", () => {
    const state = createTodoState();
    expect(() => transitionTodoState(state, {
      action: "set", phases: [{ name: "Plan", tasks: [] }, { name: "Plan", tasks: [] }],
    })).toThrow(/Duplicate phase name/);
    expect(state).toEqual(createTodoState());
  });

  it("returns cloned snapshots, including for view", () => {
    const state = createTodoState();
    const snapshot = transitionTodoState(state, { action: "view" });
    snapshot.phases[0].name = "Changed";
    expect(state.phases[0].name).toBe("Tasks");
  });

  it("returns only the requested phase for a filtered view", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [
        { name: "Plan", tasks: [{ content: "Design" }] },
        { name: "Build", tasks: [{ content: "Implement" }] },
      ],
    });

    const snapshot = transitionTodoState(state, { action: "view", phase: "Build" });

    expect(snapshot.phases).toEqual([{ name: "Build", tasks: [
      { id: "task-2", content: "Implement", status: "pending" },
    ] }]);
    expect(state.phases).toHaveLength(2);
  });
});
