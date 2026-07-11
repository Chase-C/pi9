import { describe, expect, it, vi } from "vitest";
import todoExtension from "../src/index.js";
import { TodoToolFrame } from "../src/tool-frame.js";

type RegisteredTodoTool = {
  execute: (...args: any[]) => Promise<any>;
  renderCall: (...args: any[]) => any;
  renderResult: (...args: any[]) => any;
  renderShell?: string;
};
type Handler = (...args: any[]) => unknown;

function setupTodoTool(): { tool: RegisteredTodoTool; handlers: Map<string, Handler> } {
  let tool: RegisteredTodoTool | undefined;
  const handlers = new Map<string, Handler>();
  todoExtension({
    on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }),
    registerTool: vi.fn((registered: RegisteredTodoTool) => { tool = registered; }),
  } as never);
  return { tool: tool!, handlers };
}

function executionContext(): { hasUI: false } {
  return { hasUI: false };
}

function renderContext(action: string, invalidate: () => void, expanded: boolean, toolCallId = `${action}-call`) {
  return {
    args: { action },
    toolCallId,
    invalidate,
    lastComponent: undefined,
    state: {},
    cwd: "/project",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded,
    showImages: false,
    isError: false,
  };
}

function frameText(frame: { render: (width: number) => string[] }): string {
  return frame.render(120).join("\n");
}

const renderTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("todoExtension", () => {
  it("registers the todo tool and session handlers", () => {
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    expect(() => todoExtension(pi as never)).not.toThrow();
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "todo" }));
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_tree", expect.any(Function));
  });

  it("returns task IDs and does not replace state with a filtered view", async () => {
    let tool: { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: { state: { phases: Array<{ name: string }> } } }> } | undefined;
    todoExtension({
      on: vi.fn(),
      registerTool: vi.fn((registered) => { tool = registered; }),
    } as never);

    await tool!.execute("set", {
      action: "set",
      phases: [
        { name: "Plan", tasks: [{ content: "Design" }] },
        { name: "Build", tasks: [{ content: "Implement" }] },
      ],
    });
    const filtered = await tool!.execute("filtered", { action: "view", phase: "Build" });
    const full = await tool!.execute("full", { action: "view" });

    expect(filtered.content[0].text).toContain("[task-2] Implement");
    expect(filtered.details.state.phases.map((phase) => phase.name)).toEqual(["Build"]);
    expect(full.details.state.phases.map((phase) => phase.name)).toEqual(["Plan", "Build"]);
  });

  it("uses native self-rendered lifecycle shells while preserving visibility, widget updates, and errors", async () => {
    let tool: any;
    const setWidget = vi.fn();
    todoExtension({
      on: vi.fn(),
      registerTool: vi.fn((registered) => { tool = registered; }),
    } as never);

    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const baseContext = {
      args: { action: "update" },
      isPartial: true,
      isError: false,
    };

    expect(tool.renderShell).toBe("self");
    expect(tool.renderCall({ action: "update" }, theme, baseContext).render(80)).toHaveLength(0);
    expect(tool.renderCall({ action: "update" }, theme, { ...baseContext, isPartial: false }).render(80)).toHaveLength(0);

    const pending = tool.renderCall({ action: "set", tasks: [] }, theme, { ...baseContext, args: { action: "set" } });
    expect(pending).toBeInstanceOf(TodoToolFrame);
    const pendingLines = pending.render(80);
    expect(pendingLines.length).toBeGreaterThan(0);
    expect(pendingLines.join("\n")).toContain("pending");
    const settledCall = tool.renderCall({ action: "set", tasks: [] }, theme, {
      ...baseContext,
      args: { action: "set" },
      isPartial: false,
    });
    expect(settledCall.render(80)).toHaveLength(0);

    const executionContext = { hasUI: true, ui: { setWidget } };
    const setResult = await tool.execute("set", { action: "set", tasks: [{ content: "Track work" }] }, undefined, undefined, executionContext);
    const result = await tool.execute("update", { action: "update", id: "task-1", status: "in_progress" }, undefined, undefined, executionContext);
    expect(setWidget).toHaveBeenCalled();
    const success = tool.renderResult(setResult, { expanded: false, isPartial: false }, theme, {
      ...baseContext,
      args: { action: "set" },
      isPartial: false,
    });
    expect(success).toBeInstanceOf(TodoToolFrame);
    const successLines = success.render(80);
    expect(successLines.length).toBeGreaterThan(0);
    expect(successLines.join("\n")).toContain("success");
    expect(tool.renderResult(result, { expanded: false, isPartial: false }, theme, baseContext).render(80)).toHaveLength(0);

    const error = { content: [{ type: "text", text: "Todo not found" }] };
    const errorFrame = tool.renderResult(error, { expanded: false, isPartial: false }, theme, { ...baseContext, isError: true });
    expect(errorFrame).toBeInstanceOf(TodoToolFrame);
    const errorLines = errorFrame.render(80);
    expect(errorLines.length).toBeGreaterThan(0);
    expect(errorLines.join("\n")).toContain("error");
  });

  it("keeps set snapshots and collapsed results historical while expanded rendering follows hidden updates", async () => {
    const { tool } = setupTodoTool();
    const setResult = await tool.execute("set", {
      action: "set",
      tasks: [{ content: "Original task", status: "in_progress" }],
    }, undefined, undefined, executionContext());
    const originalDetails = structuredClone(setResult.details);
    const invalidate = vi.fn();
    const expanded = tool.renderResult(
      setResult,
      { expanded: true, isPartial: false },
      renderTheme,
      renderContext("set", invalidate, true),
    );

    const updateResult = await tool.execute("update", {
      action: "update",
      id: "task-1",
      content: "Current task",
      status: "completed",
    }, undefined, undefined, executionContext());
    expect(invalidate).toHaveBeenCalledTimes(1);
    const hiddenUpdate = tool.renderResult(
      updateResult,
      { expanded: false, isPartial: false },
      renderTheme,
      renderContext("update", vi.fn(), false),
    );

    expect(hiddenUpdate.render(80)).toHaveLength(0);
    expect(setResult.details).toEqual(originalDetails);
    expect(setResult.details.state.phases[0].tasks[0]).toMatchObject({
      content: "Original task",
      status: "in_progress",
    });

    const collapsed = tool.renderResult(
      setResult,
      { expanded: false, isPartial: false },
      renderTheme,
      renderContext("set", vi.fn(), false),
    );
    const collapsedOutput = frameText(collapsed);
    expect(collapsedOutput).toContain("Original task");
    expect(collapsedOutput).toContain("1 open");
    expect(collapsedOutput).not.toContain("Current task");
    expect(collapsedOutput).not.toContain("1 completed");

    const expandedOutput = frameText(expanded);
    expect(expandedOutput).toContain("Current task");
    expect(expandedOutput).not.toContain("Original task");
    expect(expandedOutput).toContain("1/1 completed");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates only the newest rendered set after a later mutation", async () => {
    const { tool } = setupTodoTool();
    const first = await tool.execute("first", {
      action: "set",
      tasks: [{ content: "First set" }],
    }, undefined, undefined, executionContext());
    const firstInvalidate = vi.fn();
    tool.renderResult(first, { expanded: true, isPartial: false }, renderTheme, renderContext("set", firstInvalidate, true, "first-set-call"));

    const second = await tool.execute("second", {
      action: "set",
      tasks: [{ content: "Second set" }],
    }, undefined, undefined, executionContext());
    const secondInvalidate = vi.fn();
    const secondView = tool.renderResult(
      second,
      { expanded: true, isPartial: false },
      renderTheme,
      renderContext("set", secondInvalidate, true, "second-set-call"),
    );
    const firstCallsAfterReplacement = firstInvalidate.mock.calls.length;

    await tool.execute("update", {
      action: "update",
      id: "task-2",
      content: "Newest content",
      status: "completed",
    }, undefined, undefined, executionContext());

    expect(firstInvalidate).toHaveBeenCalledTimes(firstCallsAfterReplacement);
    expect(secondInvalidate).toHaveBeenCalledTimes(1);
    expect(frameText(secondView)).toContain("Newest content");
  });

  it("invalidates a live set view when session tree restoration changes the active branch", async () => {
    const { tool, handlers } = setupTodoTool();
    const setResult = await tool.execute("set", {
      action: "set",
      tasks: [{ content: "Current branch task" }],
    }, undefined, undefined, executionContext());
    const invalidate = vi.fn();
    const liveView = tool.renderResult(
      setResult,
      { expanded: true, isPartial: false },
      renderTheme,
      renderContext("set", invalidate, true),
    );
    const restoredBranch = [{
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: {
          action: "set",
          state: {
            nextId: 2,
            phases: [{
              name: "Tasks",
              tasks: [{ id: "task-1", content: "Restored branch task", status: "pending" }],
            }],
          },
        },
      },
    }];

    const sessionTree = handlers.get("session_tree");
    expect(sessionTree).toBeDefined();
    await sessionTree?.({}, {
      hasUI: false,
      sessionManager: { getBranch: () => restoredBranch },
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(frameText(liveView)).toContain("Restored branch task");
    expect(frameText(liveView)).not.toContain("Current branch task");
  });

  it("records only tasks transitioning into completed", async () => {
    let tool: { execute: (id: string, params: unknown) => Promise<{ details: { completedTaskIds?: string[] } }> } | undefined;
    todoExtension({
      on: vi.fn(),
      registerTool: vi.fn((registered) => { tool = registered; }),
    } as never);

    const initiallyComplete = await tool!.execute("initial", { action: "set", tasks: [{ content: "Already done", status: "completed" }] });
    expect(initiallyComplete.details.completedTaskIds).toEqual([]);
    const set = await tool!.execute("set", { action: "set", tasks: [{ content: "Verify" }] });
    expect(set.details.completedTaskIds).toEqual([]);
    const complete = await tool!.execute("update", { action: "update", id: "task-2", status: "completed" });
    expect(complete.details.completedTaskIds).toEqual(["task-2"]);
    const view = await tool!.execute("view", { action: "view" });
    expect(view.details.completedTaskIds).toEqual([]);
  });
});
