import { beforeEach, describe, expect, it, vi } from "vitest";
import todoExtension from "../src/index.js";
import { TodoToolFrame } from "../src/tool-frame.js";
import { describedTask } from "./helpers.js";

const settingsControl = vi.hoisted(() => ({ loaded: undefined as Record<string, unknown> | undefined }));
vi.mock("../src/settings.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/settings.js")>();
  return {
    ...original,
    loadTodoSettings: vi.fn(async () => ({
      settings: { ...original.DEFAULT_TODO_SETTINGS, ...settingsControl.loaded },
    })),
  };
});

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
const sessionContext = (entries: unknown[] = []) => ({
  hasUI: false,
  cwd: "/project",
  isProjectTrusted: () => false,
  ui: { notify: vi.fn() },
  sessionManager: { getBranch: () => entries },
});

async function endTurn(handlers: Map<string, Handler>, output?: unknown): Promise<void> {
  const message = output === undefined
    ? { role: "assistant", content: [] }
    : { role: "assistant", content: [], usage: { output } };
  await handlers.get("turn_end")?.({ type: "turn_end", turnIndex: 0, message, toolResults: [] }, executionContext);
}

async function setOpenPlan(tool: RegisteredTodoTool, task = "Implement feature"): Promise<void> {
  await tool.execute("set", {
    action: "set", phases: [{ name: "Build", tasks: [describedTask(task)] }],
  }, undefined, undefined, executionContext);
}

async function compact(
  handlers: Map<string, Handler>,
  reason: "manual" | "threshold" | "overflow" = "manual",
  willRetry = false,
): Promise<void> {
  await handlers.get("session_compact")?.({
    type: "session_compact",
    compactionEntry: {},
    fromExtension: false,
    reason,
    willRetry,
  }, executionContext);
}

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
  beforeEach(() => {
    settingsControl.loaded = undefined;
  });

  it("registers the todo tool and reminder lifecycle handlers", () => {
    const pi = { on: vi.fn(), registerTool: vi.fn() };
    expect(() => todoExtension(pi as never)).not.toThrow();
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "todo",
      parameters: expect.objectContaining({ type: "object" }),
    }));
    for (const event of ["session_start", "session_tree", "session_compact", "before_agent_start", "agent_start", "agent_settled", "turn_end", "context"]) {
      expect(pi.on).toHaveBeenCalledWith(event, expect.any(Function));
    }
    expect(pi.on).not.toHaveBeenCalledWith("session_before_compact", expect.any(Function));
  });

  it.each([
    ["manual", false],
    ["manual", true],
    ["threshold", false],
    ["threshold", true],
    ["overflow", false],
    ["overflow", true],
  ] as const)("injects one immutable snapshot after %s compaction when willRetry is %s", async (reason, willRetry) => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool);
    await compact(handlers, reason, willRetry);

    const originalMessage = { role: "assistant", content: [{ type: "text", text: "working" }] };
    const messages = [originalMessage];
    const first = await handlers.get("context")?.({ messages }, executionContext) as any;
    expect(messages).toEqual([originalMessage]);
    expect(first.messages).not.toBe(messages);
    expect(first.messages[0]).toBe(originalMessage);
    expect(first.messages[1]).toEqual({
      role: "user",
      content: expect.stringContaining("[pending] Implement feature"),
      timestamp: expect.any(Number),
    });
    expect(await handlers.get("context")?.({ messages }, executionContext)).toBeUndefined();
  });

  it("injects terminal-only plans but not plans with zero tasks", async () => {
    const empty = setupTodoTool();
    await compact(empty.handlers);
    expect(await empty.handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();

    await setOpenPlan(empty.tool, "Already shipped");
    await empty.tool.execute("complete", {
      action: "transition",
      transitions: [{ phase: "Build", task: "Already shipped", status: "completed" }],
    }, undefined, undefined, executionContext);
    await compact(empty.handlers);
    const result = await empty.handlers.get("context")?.({ messages: [] }, executionContext) as any;
    expect(result.messages[0].content).toContain("[completed] Already shipped");
  });

  it("keeps only the latest snapshot when compactions repeat before context", async () => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool, "Stale task");
    await compact(handlers, "manual", false);
    await setOpenPlan(tool, "Current task");
    await compact(handlers, "threshold", true);

    const result = await handlers.get("context")?.({ messages: [] }, executionContext) as any;
    expect(result.messages[0].content).toContain("[pending] Current task");
    expect(result.messages[0].content).not.toContain("Stale task");
  });

  it("prioritizes a compaction snapshot, resets cadence, and preserves the run cap", async () => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool);
    await endTurn(handlers);
    await handlers.get("before_agent_start")?.({}, executionContext);

    for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeDefined();
    for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);

    await compact(handlers);
    const forced = await handlers.get("context")?.({ messages: [] }, executionContext) as any;
    expect(forced.messages).toHaveLength(1);
    expect(forced.messages[0].content).toContain("todo-post-compaction");
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();

    for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeDefined();
    for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();
  });

  it.each(["session_start", "session_tree"])("clears a pending snapshot on %s", async (event) => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool);
    await compact(handlers);
    await handlers.get(event)?.({}, sessionContext());
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();
  });

  it("injects post-compaction context when dynamic reminders are disabled", async () => {
    settingsControl.loaded = { dynamicReminders: false };
    const { tool, handlers } = setupTodoTool();
    await handlers.get("session_start")?.({}, sessionContext());
    await setOpenPlan(tool);
    await compact(handlers);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeDefined();

    for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();
  });

  it("uses a minimum-turn guard before token or maximum-turn reminders", async () => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool);
    await endTurn(handlers); // Apply the successful todo interaction reset.
    await handlers.get("before_agent_start")?.({}, executionContext);

    const original = [{ role: "user", content: "work" }];
    await endTurn(handlers, 16_000);
    await endTurn(handlers);
    await endTurn(handlers);
    expect(await handlers.get("context")?.({ messages: original }, executionContext)).toBeUndefined();

    await endTurn(handlers);
    const tokenReminder = await handlers.get("context")?.({ messages: original }, executionContext) as any;
    expect(tokenReminder.messages).toHaveLength(2);

    for (let turn = 0; turn < 7; turn += 1) await endTurn(handlers, 0);
    expect(await handlers.get("context")?.({ messages: original }, executionContext)).toBeUndefined();
    await endTurn(handlers, 0);
    expect(await handlers.get("context")?.({ messages: original }, executionContext)).toEqual({
      messages: [original[0], expect.objectContaining({ role: "user" })],
    });
  });

  it("resets cadence once at turn end when concurrent todo calls include a success", async () => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool);
    await endTurn(handlers);
    for (let turn = 0; turn < 7; turn += 1) await endTurn(handlers);

    const results = await Promise.allSettled([
      tool.execute("bad-view", {
        action: "view", phase: "Missing",
      }, undefined, undefined, executionContext),
      tool.execute("view", { action: "view" }, undefined, undefined, executionContext),
    ]);
    expect(results.map(({ status }) => status)).toEqual(["rejected", "fulfilled"]);

    await endTurn(handlers);
    for (let turn = 0; turn < 7; turn += 1) await endTurn(handlers);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();
    await endTurn(handlers);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeDefined();
  });

  it("does not reset cadence when every todo call in the turn fails", async () => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool);
    await endTurn(handlers);
    for (let turn = 0; turn < 7; turn += 1) await endTurn(handlers);

    await expect(tool.execute("bad-view", {
      action: "view", phase: "Missing",
    }, undefined, undefined, executionContext)).rejects.toThrow();
    await endTurn(handlers);

    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeDefined();
  });

  it("injects transient immutable reminder messages only for open enabled plans", async () => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool);
    await endTurn(handlers);
    for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);

    const originalMessage = { role: "assistant", content: [{ type: "text", text: "working" }] };
    const messages = [originalMessage];
    const result = await handlers.get("context")?.({ messages }, executionContext) as any;
    expect(messages).toEqual([originalMessage]);
    expect(result.messages).not.toBe(messages);
    expect(result.messages[0]).toBe(originalMessage);
    expect(result.messages[1]).toEqual({
      role: "user",
      content: expect.stringContaining("<system-reminder>"),
      timestamp: expect.any(Number),
    });

    const empty = setupTodoTool();
    for (let turn = 0; turn < 8; turn += 1) await endTurn(empty.handlers);
    expect(await empty.handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();
    await setOpenPlan(empty.tool);
    await endTurn(empty.handlers);
    for (let turn = 0; turn < 8; turn += 1) await endTurn(empty.handlers);
    expect(await empty.handlers.get("context")?.({ messages: [] }, executionContext)).toBeDefined();

    settingsControl.loaded = { dynamicReminders: false };
    const disabled = setupTodoTool();
    await disabled.handlers.get("session_start")?.({}, sessionContext());
    await setOpenPlan(disabled.tool);
    await endTurn(disabled.handlers);
    for (let turn = 0; turn < 8; turn += 1) await endTurn(disabled.handlers);
    expect(await disabled.handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();
  });

  it("caps repeated reminders per run and resets only that cap before the next run", async () => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool);
    await endTurn(handlers);
    await handlers.get("before_agent_start")?.({}, executionContext);

    for (let reminder = 0; reminder < 2; reminder += 1) {
      for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);
      expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeDefined();
    }
    for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();

    await handlers.get("before_agent_start")?.({}, executionContext);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeDefined();
  });

  it("resets reminder cadence on session tree restore and tolerates missing usage", async () => {
    const { tool, handlers } = setupTodoTool();
    await setOpenPlan(tool);
    await endTurn(handlers);
    for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);

    const restoredState = { phases: [{ name: "Restored", tasks: [{ name: "Restored task", description: "Detailed description for Restored task.", status: "pending" }] }] };
    await handlers.get("session_tree")?.({}, sessionContext([{
      type: "message",
      message: {
        role: "toolResult", toolName: "todo",
        details: { action: "set", state: restoredState, changedTasks: [] },
      },
    }]));
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeUndefined();

    for (let turn = 0; turn < 8; turn += 1) await endTurn(handlers);
    expect(await handlers.get("context")?.({ messages: [] }, executionContext)).toBeDefined();
  });

  it("sets, adds, transitions, and views tasks by canonical names", async () => {
    const { tool } = setupTodoTool();
    const set = await tool.execute("set", {
      action: "set",
      phases: [
        { name: "Build", tasks: [describedTask("Implement feature")] },
        { name: "Verify", tasks: [describedTask("Run integration tests")] },
      ],
    }, undefined, undefined, executionContext);
    expect(set.content[0].text).toContain("○ Implement feature");
    expect(set.content[0].text).not.toContain("Detailed description for Implement feature.");
    expect(set.content[0].text).not.toContain("task-");
    expect(set.details.changedTasks).toEqual([
      { phase: "Build", task: "Implement feature" },
      { phase: "Verify", task: "Run integration tests" },
    ]);

    const add = await tool.execute("add", {
      action: "add",
      phases: [{ name: "Build", tasks: [describedTask("Handle invalid input")] }],
    }, undefined, undefined, executionContext);
    expect(add.details.changedTasks).toEqual([{ phase: "Build", task: "Handle invalid input" }]);

    const transition = await tool.execute("transition", {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "completed" }],
    }, undefined, undefined, executionContext);
    expect(transition.details.changedTasks).toEqual([{ phase: "Build", task: "Implement feature" }]);

    const view = await tool.execute("view", { action: "view" }, undefined, undefined, executionContext);
    expect(view.details.state.phases.map((phase: any) => phase.name)).toEqual(["Build", "Verify"]);
    expect(view.content[0].text).toContain("Implement feature — Detailed description for Implement feature.");
    expect(view.content[0].text).toContain("Run integration tests — Detailed description for Run integration tests.");
    expect(view.details.changedTasks).toEqual([]);
  });

  it("makes set destructive and resets supplied tasks to pending", async () => {
    const { tool } = setupTodoTool();
    await tool.execute("set", {
      action: "set",
      phases: [{ name: "Build", tasks: [describedTask("Old task")] }],
    }, undefined, undefined, executionContext);
    await tool.execute("transition", {
      action: "transition",
      transitions: [{ phase: "Build", task: "Old task", status: "completed" }],
    }, undefined, undefined, executionContext);
    const reset = await tool.execute("reset", {
      action: "set",
      phases: [{ name: "Verify", tasks: [describedTask("New task")] }],
    }, undefined, undefined, executionContext);
    expect(reset.details.state).toEqual({
      phases: [{ name: "Verify", tasks: [{ name: "New task", description: "Detailed description for New task.", status: "pending" }] }],
    });
  });

  it("uses self-rendered lifecycle shells and preserves visibility", async () => {
    const { tool } = setupTodoTool();
    const styledTheme = {
      ...theme,
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    };
    const partial = { args: { action: "set" }, isPartial: true, isError: false };
    expect(tool.renderShell).toBe("self");
    expect(tool.renderCall({ action: "add" }, theme, { ...partial, args: { action: "add" } }).render(80)).toHaveLength(0);
    const pending = tool.renderCall({
      action: "set",
      phases: [
        { name: "Build", tasks: [describedTask("Implement feature"), describedTask("Add tests")] },
        { name: "Verify", tasks: [describedTask("Run checks")] },
      ],
    }, styledTheme, partial);
    expect(pending).toBeInstanceOf(TodoToolFrame);
    expect(pending.render(80).join("\n")).toContain("<muted>2 phases · 3 tasks</muted>");
    expect(pending.render(80).join("\n")).not.toContain("pending");

    const result = await tool.execute("set", {
      action: "set", phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
    }, undefined, undefined, executionContext);
    const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, styledTheme, renderContext("set"));
    expect(rendered).toBeInstanceOf(TodoToolFrame);
    expect(rendered.render(80).join("\n")).toContain("<muted>1 phase · 1 task</muted>");
    expect(rendered.render(80).join("\n")).not.toContain("success");
  });

  it("keeps the latest expanded set result live through additions and transitions", async () => {
    const { tool } = setupTodoTool();
    const set = await tool.execute("set", {
      action: "set", phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
    }, undefined, undefined, executionContext);
    const historical = structuredClone(set.details);
    const invalidate = vi.fn();
    const live = tool.renderResult(set, { expanded: true, isPartial: false }, theme, renderContext("set", invalidate));

    await tool.execute("add", {
      action: "add", phases: [{ name: "Build", tasks: [describedTask("Add tests")] }],
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
      action: "set", phases: [{ name: "Current", tasks: [describedTask("Current task")] }],
    }, undefined, undefined, executionContext);
    const restoredState = { phases: [{ name: "Restored", tasks: [{ name: "Restored task", description: "Detailed description for Restored task.", status: "pending" }] }] };
    await handlers.get("session_tree")?.({}, {
      hasUI: false,
      sessionManager: { getBranch: () => [{
        type: "message",
        message: {
          role: "toolResult", toolName: "todo",
          details: { action: "set", state: restoredState, changedTasks: [] },
        },
      }] },
    });
    const view = await tool.execute("view", { action: "view" }, undefined, undefined, executionContext);
    expect(view.details.state).toEqual(restoredState);
  });

  it("serializes concurrent mutations", async () => {
    const { tool } = setupTodoTool();
    await tool.execute("set", { action: "set", phases: [{ name: "Build", tasks: [describedTask("First task")] }] }, undefined, undefined, executionContext);
    await Promise.all([
      tool.execute("one", { action: "add", phases: [{ name: "Build", tasks: [describedTask("Second task")] }] }, undefined, undefined, executionContext),
      tool.execute("two", { action: "add", phases: [{ name: "Build", tasks: [describedTask("Third task")] }] }, undefined, undefined, executionContext),
    ]);
    const view = await tool.execute("view", { action: "view" }, undefined, undefined, executionContext);
    expect(view.details.state.phases[0].tasks.map((task: any) => task.name)).toEqual(["First task", "Second task", "Third task"]);
  });
});
