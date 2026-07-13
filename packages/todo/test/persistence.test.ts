import { describe, expect, it } from "vitest";
import { restoreTodoState } from "../src/persistence.js";
import { cloneTodoState } from "../src/state.js";
import type { TodoState } from "../src/types.js";

const state = (name: string): TodoState => ({
  phases: [{ name, tasks: [{ name: `Complete ${name}`, status: "pending" }] }],
});

const contextFor = (entries: unknown[]) => ({
  sessionManager: { getBranch: () => entries },
});

const todoResult = (snapshot: unknown, options: { isError?: boolean; action?: unknown } = {}) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolName: "todo",
    isError: options.isError ?? false,
    details: { action: "action" in options ? options.action : "add", state: snapshot },
  },
});

describe("todo persistence", () => {
  it("clones state without retaining nested references", () => {
    const original = state("Build");
    const copy = cloneTodoState(original);

    expect(copy).toEqual(original);
    expect(copy.phases).not.toBe(original.phases);
    expect(copy.phases[0]).not.toBe(original.phases[0]);
    expect(copy.phases[0].tasks[0]).not.toBe(original.phases[0].tasks[0]);
  });

  it("restores the newest valid snapshot in active branch order", () => {
    const restored = restoreTodoState(contextFor([
      todoResult(state("Plan")),
      { type: "message", message: { role: "toolResult", toolName: "other", details: { state: state("Other") } } },
      todoResult(state("Build")),
    ]));
    expect(restored).toEqual(state("Build"));
  });

  it("skips failed and malformed results", () => {
    const restored = restoreTodoState(contextFor([
      todoResult(state("Plan")),
      todoResult(state("Failed"), { isError: true }),
      todoResult({ phases: [{ name: "Bad", tasks: [{ name: "Task", status: "doing" }] }] }),
      todoResult(state("Wrong action"), { action: null }),
    ]));
    expect(restored).toEqual(state("Plan"));
  });

  it("rejects malformed state invariants", () => {
    const duplicateTasks = { phases: [{ name: "Build", tasks: [
      { name: "Same", status: "pending" },
      { name: "Same", status: "completed" },
    ] }] };
    const splitActive = { phases: [
      { name: "Build", tasks: [{ name: "Build task", status: "in_progress" }] },
      { name: "Verify", tasks: [{ name: "Verify task", status: "in_progress" }] },
    ] };
    expect(restoreTodoState(contextFor([todoResult(duplicateTasks)]))).toEqual({ phases: [] });
    expect(restoreTodoState(contextFor([todoResult(splitActive)]))).toEqual({ phases: [] });
  });

  it("returns an independent empty state when no valid snapshot exists", () => {
    const first = restoreTodoState(contextFor([]));
    const second = restoreTodoState(contextFor([]));

    expect(first).toEqual({ phases: [] });
    expect(second).not.toBe(first);
    expect(second.phases).not.toBe(first.phases);
  });
});
