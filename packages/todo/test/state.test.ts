import { describe, expect, it } from "vitest";
import { createTodoState, transitionTodoState } from "../src/state.js";
import { describedTask } from "./helpers.js";

describe("todo state", () => {
  it("sets a fresh pending plan and discards all previous state", () => {
    const previous = {
      phases: [{ name: "Old", tasks: [{ name: "Finished old work", description: "Detailed description for Finished old work.", status: "completed" as const }] }],
    };
    const next = transitionTodoState(previous, {
      action: "set",
      phases: [{ name: "Build", tasks: [describedTask("Implement session restoration"), describedTask("Add integration coverage")] }],
    });

    expect(next).toEqual({ phases: [{ name: "Build", tasks: [
      { name: "Implement session restoration", description: "Detailed description for Implement session restoration.", status: "pending" },
      { name: "Add integration coverage", description: "Detailed description for Add integration coverage.", status: "pending" },
    ] }] });
    expect(previous.phases[0].tasks[0].status).toBe("completed");
  });

  it("requires set and add to contain non-empty phases", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
    });

    expect(() => transitionTodoState(state, { action: "set", phases: [] })).toThrow(/at least one phase/);
    expect(() => transitionTodoState(state, {
      action: "set",
      phases: [{ name: "Build", tasks: [] }],
    })).toThrow(/at least one task/);
    expect(() => transitionTodoState(state, { action: "add", phases: [] })).toThrow(/at least one phase/);
    expect(() => transitionTodoState(state, {
      action: "add",
      phases: [{ name: "Build", tasks: [] }],
    })).toThrow(/at least one task/);
  });

  it("adds tasks to existing and missing phases without changing statuses", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
    });
    const active = transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "in_progress" }],
      workingOn: "Implementing the feature",
    });
    const next = transitionTodoState(active, {
      action: "add",
      phases: [
        { name: "Build", tasks: [describedTask("Handle invalid input")] },
        { name: "Verify", tasks: [describedTask("Run integration tests")] },
      ],
    });

    expect(next.workingOn).toBe("Implementing the feature");
    expect(next.phases).toEqual([
      { name: "Build", tasks: [
        { name: "Implement feature", description: "Detailed description for Implement feature.", status: "in_progress" },
        { name: "Handle invalid input", description: "Detailed description for Handle invalid input.", status: "pending" },
      ] },
      { name: "Verify", tasks: [{ name: "Run integration tests", description: "Detailed description for Run integration tests.", status: "pending" }] },
    ]);
  });

  it("rejects empty and duplicate additions atomically", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
    });

    expect(() => transitionTodoState(state, {
      action: "add",
      phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
    })).toThrow(/Duplicate task name/);
    expect(() => transitionTodoState(state, {
      action: "add",
      phases: [
        { name: "Verify", tasks: [describedTask("Run tests")] },
        { name: "Verify", tasks: [describedTask("Inspect output")] },
      ],
    })).toThrow(/Duplicate phase name/);
    expect(state.phases).toHaveLength(1);
  });

  it("reserves cancelled task names and permits reactivation", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
    });
    const cancelled = transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "cancelled" }],
    });

    expect(() => transitionTodoState(cancelled, {
      action: "add",
      phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
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
        { name: "Build", tasks: [describedTask("Implement feature")] },
        { name: "Verify", tasks: [describedTask("Run tests")] },
      ],
    });
    const active = transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "in_progress" }],
      workingOn: "Implementing the feature",
    });
    const next = transitionTodoState(active, {
      action: "transition",
      transitions: [
        { phase: "Build", task: "Implement feature", status: "completed" },
        { phase: "Verify", task: "Run tests", status: "in_progress" },
      ],
      workingOn: "Running the tests",
    });

    expect(next.phases[0].tasks[0].status).toBe("completed");
    expect(next.phases[1].tasks[0].status).toBe("in_progress");
    expect(next.workingOn).toBe("Running the tests");
    expect(() => transitionTodoState(state, {
      action: "transition",
      transitions: [
        { phase: "Build", task: "Implement feature", status: "in_progress" },
        { phase: "Verify", task: "Run tests", status: "in_progress" },
      ],
      workingOn: "Working in two phases",
    })).toThrow(/conflicting phases: Build and Verify/);
  });

  it("requires current work on every transition that leaves tasks active and clears it automatically", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: [describedTask("Implement feature"), describedTask("Remove dead code")] }],
    });
    expect(() => transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "in_progress" }],
    })).toThrow(/requires workingOn/);
    expect(() => transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "in_progress" }],
      workingOn: "",
    })).toThrow(/non-empty string/);

    const active = transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "in_progress" }],
      workingOn: "Implementing the feature",
    });
    expect(active.workingOn).toBe("Implementing the feature");
    expect(() => transitionTodoState(active, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Remove dead code", status: "cancelled" }],
    })).toThrow(/requires workingOn/);
    expect(transitionTodoState(active, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Remove dead code", status: "cancelled" }],
      workingOn: "Implementing the feature",
    }).workingOn).toBe("Implementing the feature");

    expect(transitionTodoState(active, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "completed" }],
    })).not.toHaveProperty("workingOn");
    expect(() => transitionTodoState(active, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "completed" }],
      workingOn: null,
    })).toThrow(/non-empty string/);
  });

  it("requires non-empty phase names, task names, and descriptions", () => {
    expect(() => transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "", tasks: [describedTask("Implement feature")] }],
    })).toThrow(/non-empty string/);
    expect(() => transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: [{ name: "Implement feature" }] }],
    })).toThrow(/description/);
    expect(() => transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: [{ name: "", description: "Implement the feature." }] }],
    })).toThrow(/non-empty string/);
    expect(() => transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: [{ name: "Implement feature", description: "" }] }],
    })).toThrow(/non-empty string/);
  });

  it("rejects duplicate or unresolved transitions without mutating state", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [{ name: "Build", tasks: [describedTask("Implement feature"), describedTask("Add tests")] }],
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
      phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
    });
    expect(() => transitionTodoState(state, {
      action: "transition",
      transitions: [{ phase: "build", task: "Implement feature", status: "completed" }],
    })).toThrow(/Phase not found/);
    expect(() => transitionTodoState(state, {
      action: "add",
      phases: [{ name: " Build", tasks: [describedTask("Add tests")] }],
    })).toThrow(/leading or trailing whitespace/);
  });

  it("returns the full plan for view and rejects filters", () => {
    const state = transitionTodoState(createTodoState(), {
      action: "set",
      phases: [
        { name: "Build", tasks: [describedTask("Implement feature")] },
        { name: "Verify", tasks: [describedTask("Run tests")] },
      ],
    });

    expect(transitionTodoState(state, { action: "view" })).toBe(state);
    expect(() => transitionTodoState(state, { action: "view", phase: "Verify" })).toThrow(/does not accept field: phase/);
  });

  it("rejects fields that do not belong to the selected action", () => {
    expect(() => transitionTodoState(createTodoState(), {
      action: "view",
      phases: [],
    })).toThrow(/does not accept field: phases/);
  });
});
