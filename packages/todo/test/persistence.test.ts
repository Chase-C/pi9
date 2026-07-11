import { describe, expect, it } from "vitest";
import { cloneTodoState, restoreTodoState } from "../src/persistence.js";

const state = (nextId: number) => ({
  phases: [{ name: `Phase ${nextId}`, tasks: [] }],
  nextId,
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
    const original = state(2);
    const copy = cloneTodoState(original);

    copy.phases[0].name = "Changed";

    expect(copy).toEqual({ phases: [{ name: "Changed", tasks: [] }], nextId: 2 });
    expect(original.phases[0].name).toBe("Phase 2");
  });

  it("restores the newest valid snapshot in active branch order", () => {
    const restored = restoreTodoState(
      contextFor([
        todoResult(state(2)),
        { type: "message", message: { role: "toolResult", toolName: "other", details: { state: state(3) } } },
        todoResult(state(4)),
      ]),
    );

    expect(restored).toEqual(state(4));
  });

  it("skips failed and malformed results to find an earlier valid snapshot", () => {
    const restored = restoreTodoState(
      contextFor([
        todoResult(state(2)),
        todoResult(state(3), { isError: true }),
        todoResult({ phases: "not an array", nextId: 4 }),
        todoResult(state(5), { action: null }),
      ]),
    );

    expect(restored).toEqual(state(2));
  });

  it("returns an independent empty state when no valid snapshot exists", () => {
    const restored = restoreTodoState(contextFor([{ type: "message", message: { role: "assistant" } }]));

    restored.phases.push({ name: "local", tasks: [] });

    expect(restored.nextId).toBe(1);
    expect(restoreTodoState(contextFor([]))).toEqual({ phases: [], nextId: 1 });
  });
});
