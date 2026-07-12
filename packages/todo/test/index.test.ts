import { describe, expect, it, vi } from "vitest";
import todoExtension from "../src/index.js";
import { TodoToolFrame } from "../src/tool-frame.js";

type Handler = (...args: any[]) => unknown;
type RegisteredTodoTool = {
  execute: (...args: any[]) => Promise<any>;
  renderCall: (...args: any[]) => any;
  renderResult: (...args: any[]) => any;
  renderShell?: string;
};

function setupTodoTool(): { tool: RegisteredTodoTool; handlers: Map<string, Handler> } {
  let tool: RegisteredTodoTool | undefined;
  const handlers = new Map<string, Handler>();
  todoExtension({
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerTool: vi.fn((registered: RegisteredTodoTool) => { tool = registered; }),
  } as never);
  return { tool: tool!, handlers };
}

const executionContext = { hasUI: false };
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function renderContext(action: string, invalidate = vi.fn(), toolCallId = `${action}-call`) {
  return {
    args: { action }, toolCallId, invalidate, lastComponent: undefined, state: {}, cwd: "/project",
    executionStarted: true, argsComplete: true, isPartial: false, expanded: true, showImages: false, isError: false,
  };
}

describe("todoExtension", () => {
  it("registers the todo tool and session handlers", () => {
    const pi = { on: vi.fn(), registerTool: vi.fn() };
    expect(() => todoExtension(pi as never)).not.toThrow();
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "todo",
      parameters: expect.objectContaining({ type: "object" }),
    }));
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_tree", expect.any(Function));
  });

  it("sets, adds, transitions, and views tasks by canonical names", async () => {
    const { tool } = setupTodoTool();
    const set = await tool.execute("set", {
      action: "set",
      phases: [
        { name: "Build", tasks: ["Implement feature"] },
        { name: "Verify", tasks: ["Run integration tests"] },
      ],
    }, undefined, undefined, executionContext);
    expect(set.content[0].text).toContain("○ Implement feature");
    expect(set.content[0].text).not.toContain("task-");
    expect(set.details.changedTasks).toEqual([
      { phase: "Build", task: "Implement feature" },
      { phase: "Verify", task: "Run integration tests" },
    ]);

    const add = await tool.execute("add", {
      action: "add",
      phases: [{ name: "Build", tasks: ["Handle invalid input"] }],
    }, undefined, undefined, executionContext);
    expect(add.details.changedTasks).toEqual([{ phase: "Build", task: "Handle invalid input" }]);

    const transition = await tool.execute("transition", {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "completed" }],
    }, undefined, undefined, executionContext);
    expect(transition.details.changedTasks).toEqual([{ phase: "Build", task: "Implement feature" }]);
    expect(transition.details.completedTasks).toEqual([{ phase: "Build", task: "Implement feature" }]);

    const filtered = await tool.execute("view", { action: "view", phase: "Build" }, undefined, undefined, executionContext);
    const full = await tool.execute("view", { action: "view" }, undefined, undefined, executionContext);
    expect(filtered.details.state.phases.map((phase: any) => phase.name)).toEqual(["Build"]);
    expect(full.details.state.phases.map((phase: any) => phase.name)).toEqual(["Build", "Verify"]);
    expect(full.details.changedTasks).toEqual([]);
  });

  it("makes set destructive and resets supplied tasks to pending", async () => {
    const { tool } = setupTodoTool();
    await tool.execute("set", {
      action: "set",
      phases: [{ name: "Build", tasks: ["Old task"] }],
    }, undefined, undefined, executionContext);
    await tool.execute("transition", {
      action: "transition",
      transitions: [{ phase: "Build", task: "Old task", status: "completed" }],
    }, undefined, undefined, executionContext);
    const reset = await tool.execute("reset", {
      action: "set",
      phases: [{ name: "Verify", tasks: ["New task"] }],
    }, undefined, undefined, executionContext);
    expect(reset.details.state).toEqual({
      phases: [{ name: "Verify", tasks: [{ name: "New task", status: "pending" }] }],
    });
  });

  it("uses self-rendered lifecycle shells and preserves visibility", async () => {
    const { tool } = setupTodoTool();
    const partial = { args: { action: "set" }, isPartial: true, isError: false };
    expect(tool.renderShell).toBe("self");
    expect(tool.renderCall({ action: "add" }, theme, { ...partial, args: { action: "add" } }).render(80)).toHaveLength(0);
    const pending = tool.renderCall({ action: "set", phases: [] }, theme, partial);
    expect(pending).toBeInstanceOf(TodoToolFrame);
    expect(pending.render(80).join("\n")).toContain("pending");

    const result = await tool.execute("set", {
      action: "set", phases: [{ name: "Build", tasks: ["Implement feature"] }],
    }, undefined, undefined, executionContext);
    const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext("set"));
    expect(rendered).toBeInstanceOf(TodoToolFrame);
    expect(rendered.render(80).join("\n")).toContain("success");
  });

  it("keeps the latest expanded set result live through additions and transitions", async () => {
    const { tool } = setupTodoTool();
    const set = await tool.execute("set", {
      action: "set", phases: [{ name: "Build", tasks: ["Implement feature"] }],
    }, undefined, undefined, executionContext);
    const historical = structuredClone(set.details);
    const invalidate = vi.fn();
    const live = tool.renderResult(set, { expanded: true, isPartial: false }, theme, renderContext("set", invalidate));

    await tool.execute("add", {
      action: "add", phases: [{ name: "Build", tasks: ["Add tests"] }],
    }, undefined, undefined, executionContext);
    await tool.execute("transition", {
      action: "transition", transitions: [{ phase: "Build", task: "Implement feature", status: "completed" }],
    }, undefined, undefined, executionContext);

    const text = live.render(120).join("\n");
    expect(text).toContain("Implement feature");
    expect(text).toContain("Add tests");
    expect(text).toContain("1 completed");
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(set.details).toEqual(historical);
  });

  it("restores state when session tree navigation changes branches", async () => {
    const { tool, handlers } = setupTodoTool();
    await tool.execute("set", {
      action: "set", phases: [{ name: "Current", tasks: ["Current task"] }],
    }, undefined, undefined, executionContext);
    const restoredState = { phases: [{ name: "Restored", tasks: [{ name: "Restored task", status: "pending" }] }] };
    await handlers.get("session_tree")?.({}, {
      hasUI: false,
      sessionManager: { getBranch: () => [{
        type: "message",
        message: {
          role: "toolResult", toolName: "todo",
          details: { action: "set", state: restoredState, changedTasks: [], completedTasks: [] },
        },
      }] },
    });
    const view = await tool.execute("view", { action: "view" }, undefined, undefined, executionContext);
    expect(view.details.state).toEqual(restoredState);
  });

  it("serializes concurrent mutations", async () => {
    const { tool } = setupTodoTool();
    await tool.execute("set", { action: "set", phases: [{ name: "Build", tasks: ["First task"] }] }, undefined, undefined, executionContext);
    await Promise.all([
      tool.execute("one", { action: "add", phases: [{ name: "Build", tasks: ["Second task"] }] }, undefined, undefined, executionContext),
      tool.execute("two", { action: "add", phases: [{ name: "Build", tasks: ["Third task"] }] }, undefined, undefined, executionContext),
    ]);
    const view = await tool.execute("view", { action: "view" }, undefined, undefined, executionContext);
    expect(view.details.state.phases[0].tasks.map((task: any) => task.name)).toEqual(["First task", "Second task", "Third task"]);
  });
});
