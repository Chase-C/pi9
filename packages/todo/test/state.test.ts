import { describe, expect, it } from "vitest";
import { createTodoState, transitionTodoState } from "../src/state.js";

describe("todo state", () => {
  it("sets a fresh pending plan and discards all previous state", () => {
    const previous = {
      phases: [{ name: "Old", tasks: [{ name: "Finished old work", status: "completed" as const }] }],
    };
    const next = transitionTodoState(previous, {
      action: "set",
      phases: [{ name: "Build", tasks: ["Implement session restoration", "Add integration coverage"] }],
    });

    expect(next).toEqual({ phases: [{ name: "Build", tasks: [
      { name: "Implement session restoration", status: "pending" },
      { name: "Add integration coverage", status: "pending" },
    ] }] });
    expect(previous.phases[0].tasks[0].status).toBe("completed");
  });

  it("allows set to clear the plan", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: ["Implement feature"] }],
    });
    expect(transitionTodoState(state, { action: "set", phases: [] })).toEqual({ phases: [] });
  });

  it("adds tasks to existing and missing phases without changing statuses", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: ["Implement feature"] }],
    });
    const active = transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "in_progress" }],
    });
    const next = transitionTodoState(active, {
      action: "add",
      phases: [
        { name: "Build", tasks: ["Handle invalid input"] },
        { name: "Verify", tasks: ["Run integration tests"] },
      ],
    });

    expect(next.phases).toEqual([
      { name: "Build", tasks: [
        { name: "Implement feature", status: "in_progress" },
        { name: "Handle invalid input", status: "pending" },
      ] },
      { name: "Verify", tasks: [{ name: "Run integration tests", status: "pending" }] },
    ]);
  });

  it("rejects empty and duplicate additions atomically", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: ["Implement feature"] }],
    });

    expect(() => transitionTodoState(state, { action: "add", phases: [] })).toThrow(/at least one task/);
    expect(() => transitionTodoState(state, {
      action: "add",
      phases: [{ name: "Build", tasks: ["Implement feature"] }],
    })).toThrow(/Duplicate task name/);
    expect(() => transitionTodoState(state, {
      action: "add",
      phases: [
        { name: "Verify", tasks: ["Run tests"] },
        { name: "Verify", tasks: ["Inspect output"] },
      ],
    })).toThrow(/Duplicate phase name/);
    expect(state.phases).toHaveLength(1);
  });

  it("reserves cancelled task names and permits reactivation", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: ["Implement feature"] }],
    });
    const cancelled = transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "cancelled" }],
    });

    expect(() => transitionTodoState(cancelled, {
      action: "add",
      phases: [{ name: "Build", tasks: ["Implement feature"] }],
    })).toThrow(/Duplicate task name/);
    expect(transitionTodoState(cancelled, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "pending" }],
    }).phases[0].tasks[0].status).toBe("pending");
  });

  it("applies status transitions atomically against the final state", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [
        { name: "Build", tasks: ["Implement feature"] },
        { name: "Verify", tasks: ["Run tests"] },
      ],
    });
    const active = transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "in_progress" }],
    });
    const next = transitionTodoState(active, {
      action: "transition",
      transitions: [
        { phase: "Build", task: "Implement feature", status: "completed" },
        { phase: "Verify", task: "Run tests", status: "in_progress" },
      ],
    });

    expect(next.phases[0].tasks[0].status).toBe("completed");
    expect(next.phases[1].tasks[0].status).toBe("in_progress");
    expect(() => transitionTodoState(state, {
      action: "transition",
      transitions: [
        { phase: "Build", task: "Implement feature", status: "in_progress" },
        { phase: "Verify", task: "Run tests", status: "in_progress" },
      ],
    })).toThrow(/one phase/);
  });

  it("rejects duplicate or unresolved transitions without mutating state", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: ["Implement feature", "Add tests"] }],
    });
    expect(() => transitionTodoState(state, {
      action: "transition",
      transitions: [
        { phase: "Build", task: "Implement feature", status: "completed" },
        { phase: "Build", task: "Implement feature", status: "cancelled" },
      ],
    })).toThrow(/only be transitioned once/);
    expect(() => transitionTodoState(state, {
      action: "transition",
      transitions: [
        { phase: "Build", task: "Implement feature", status: "completed" },
        { phase: "Build", task: "Missing task", status: "completed" },
      ],
    })).toThrow(/Current tasks in Build[\s\S]*Implement feature/);
    expect(state.phases[0].tasks.every((task) => task.status === "pending")).toBe(true);
  });

  it("uses exact case-sensitive names and rejects surrounding whitespace", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: ["Implement feature"] }],
    });
    expect(() => transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "build", task: "Implement feature", status: "completed" }],
    })).toThrow(/Phase not found/);
    expect(() => transitionTodoState(state, {
      action: "add",
      phases: [{ name: " Build", tasks: ["Add tests"] }],
    })).toThrow(/leading or trailing whitespace/);
  });

  it("filters view snapshots without mutating state", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [
        { name: "Build", tasks: ["Implement feature"] },
        { name: "Verify", tasks: ["Run tests"] },
      ],
    });
    const view = transitionTodoState(state, { action: "view", phase: "Verify" });
    expect(view.phases.map((phase) => phase.name)).toEqual(["Verify"]);
    expect(state.phases).toHaveLength(2);
  });

  it("rejects fields that do not belong to the selected action", () => {
    expect(() => transitionTodoState(createTodoState(), {
      action: "view",
      phases: [],
    })).toThrow(/does not accept field: phases/);
  });
});
