import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import askExtension from "../src/index.js";

function register(initialActiveTools: string[] = []) {
  let tool: any;
  let activeTools = [...initialActiveTools];
  const handlers = new Map<string, any>();
  const emit = vi.fn();
  const sendMessage = vi.fn();
  const getActiveTools = vi.fn(() => activeTools);
  const setActiveTools = vi.fn((tools: string[]) => { activeTools = tools; });
  askExtension({
    registerTool: (definition: unknown) => { tool = definition; },
    sendMessage,
    getActiveTools,
    setActiveTools,
    on: (event: string, handler: unknown) => { handlers.set(event, handler); },
    events: { emit },
  } as never);
  const contextHandler = handlers.get("context");
  if (!tool || !contextHandler) throw new Error("ask integration was not registered");
  return { tool, contextHandler, handlers, emit, sendMessage, getActiveTools, setActiveTools };
}

const rpcUi = (answer = "1. Yes") => ({
  select: vi.fn().mockResolvedValue(answer),
  input: vi.fn().mockResolvedValue(""),
});

async function withTimeoutEnv<T>(value: string | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env.PI9_ASK_TIMEOUT_MS;
  if (value === undefined) delete process.env.PI9_ASK_TIMEOUT_MS;
  else process.env.PI9_ASK_TIMEOUT_MS = value;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.PI9_ASK_TIMEOUT_MS;
    else process.env.PI9_ASK_TIMEOUT_MS = previous;
  }
}

function keybindings() {
  return new KeybindingsManager(TUI_KEYBINDINGS, {});
}

function pendingTui() {
  return vi.fn((factory: any) => new Promise(resolve => {
    factory({ requestRender: vi.fn() }, theme(), keybindings(), resolve);
  }));
}

describe("ask extension integration", () => {
  it("describes the focused-question contract to the model", () => {
    const { tool } = register();
    const guidance = tool.promptGuidelines.join("\n");

    expect(tool.description).toContain("selectable options");
    expect(tool.description).toContain("answered, cancelled, or timed out");
    expect(guidance).toContain("open-ended questions");
    expect(guidance).toContain("ask_response");
    expect(guidance).toContain("do not re-ask");
  });

  it("registers session-start and before-agent-start hooks", () => {
    const { handlers } = register();
    expect(handlers.get("session_start")).toBeTypeOf("function");
    expect(handlers.get("before_agent_start")).toBeTypeOf("function");
  });

  it("deactivates ask at no-UI session start while preserving siblings", () => {
    const { handlers, getActiveTools, setActiveTools } = register(["read", "ask", "bash"]);
    const sessionStart = handlers.get("session_start");

    sessionStart({}, { hasUI: false, sessionManager: { getBranch: () => [] } });
    expect(getActiveTools).toHaveBeenCalledOnce();
    expect(setActiveTools).toHaveBeenCalledWith(["read", "bash"]);

    handlers.get("before_agent_start")({}, { hasUI: false });
    expect(getActiveTools).toHaveBeenCalledTimes(2);
    expect(setActiveTools).toHaveBeenCalledOnce();
  });

  it("does not mutate active tools again when ask is already absent", () => {
    const { handlers, setActiveTools } = register(["read", "ask"]);
    const beforeAgentStart = handlers.get("before_agent_start");

    beforeAgentStart({}, { hasUI: false });
    beforeAgentStart({}, { hasUI: false });

    expect(setActiveTools).toHaveBeenCalledOnce();
    expect(setActiveTools).toHaveBeenCalledWith(["read"]);
  });

  it.each(["tui", "rpc"])("leaves active tools untouched with UI in %s mode", (mode) => {
    const { handlers, getActiveTools, setActiveTools } = register(["read", "ask"]);

    handlers.get("session_start")({}, { mode, hasUI: true, sessionManager: { getBranch: () => [] } });

    expect(getActiveTools).not.toHaveBeenCalled();
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  it("does not re-add an intentionally absent ask tool with UI", () => {
    const { handlers, getActiveTools, setActiveTools } = register(["read"]);

    handlers.get("session_start")({}, { hasUI: true, sessionManager: { getBranch: () => [] } });

    expect(getActiveTools).not.toHaveBeenCalled();
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  it("registers the strict sequential tool, guidance, renderers, and context pruning", () => {
    const { tool, contextHandler } = register();
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.executionMode).toBe("sequential");
    const rendererContext = { state: {}, args: { question: "Choose?", options: [{ label: "Yes" }] }, lastComponent: undefined };
    expect(tool.renderCall(rendererContext.args, theme(), rendererContext).render(80).join("\n")).toContain("Choose?");
    expect(tool.renderResult({ content: [{ type: "text", text: "Selected: Yes" }] }, {}, theme(), rendererContext).render(80).join("\n")).toContain("Selected: Yes");

    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "ask", arguments: { question: "Choose", options: [{ label: "Yes" }, { label: "No" }] } }] },
      { role: "toolResult", toolCallId: "a", toolName: "ask", details: { status: "answered", answer: { selections: [{ option: 0 }] } }, content: [{ type: "text", text: "original verbose result" }], isError: false, timestamp: 2 },
    ];
    const rewritten = contextHandler({ messages }).messages as any[];
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]).toMatchObject({
      role: "custom",
      customType: "ask:summary",
      display: false,
      timestamp: expect.any(Number),
    });
    expect(JSON.parse(rewritten[0].content)).toEqual({
      type: "ask_response",
      question: "Choose",
      selectionMode: "single",
      answer: { selections: [{ label: "Yes" }] },
    });
    expect(messages[0].content[0].arguments.options).toHaveLength(2);
  });

  it("renders the pending response type and the answered option list", () => {
    const { tool } = register();
    const styledTheme = {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as any;
    const state = {};
    const args = {
      question: "Choose?",
      options: [
        { label: "Alpha", description: "First" },
        { label: "Beta", description: "Second" },
      ],
      allowMultiple: false,
      allowFreeform: true,
    };
    const context = { state, args, lastComponent: undefined };
    const call = tool.renderCall(args, styledTheme, context);

    expect(call.render(80).map((line: string) => line.trimEnd())).toEqual(["[toolTitle]ask [muted]Choose?", "[muted]╰ options:2"]);

    const answered = tool.renderResult({
      content: [{ type: "text", text: "Selected: Beta" }],
      details: {
        status: "answered",
        answer: { selections: [{ option: 1, comment: "Best fit" }], freeform: "Something else" },
      },
    }, {}, styledTheme, context);
    expect(call.render(80).map((line: string) => line.trimEnd())).toEqual(["[toolTitle]ask [text]Choose?"]);
    expect(answered.render(80).map((line: string) => line.trimEnd())).toEqual([
      "[muted]╰ [muted]󰄰 [muted]Alpha",
      "  [success]󰄴 [text]Beta (Best fit)",
      "  [success]󰄴 [text]Something else",
    ]);

    const withoutFreeform = tool.renderResult({
      content: [{ type: "text", text: "Selected: Alpha" }],
      details: { status: "answered", answer: { selections: [{ option: 0 }] } },
    }, {}, styledTheme, { state: {}, args, lastComponent: undefined });
    expect(withoutFreeform.render(80)).toHaveLength(2);

    const multiArgs = { question: "Choose several", options: [{ label: "Alpha" }, { label: "Beta" }], allowMultiple: true };
    const multiContext = { state: {}, args: multiArgs, lastComponent: undefined };
    expect(tool.renderCall(multiArgs, styledTheme, multiContext).render(80)[1].trimEnd()).toBe("[muted]╰ multi · options:2");
    const multiAnswered = tool.renderResult({
      content: [{ type: "text", text: "Selected: Beta" }],
      details: { status: "answered", answer: { selections: [{ option: 1 }] } },
    }, {}, styledTheme, multiContext);
    expect(multiAnswered.render(80).map((line: string) => line.trimEnd())).toEqual([
      "[muted]╰ [muted]󰄱 [muted]Alpha",
      "  [success]󰄵 [text]Beta",
    ]);
  });

  it("hangs wrapped freeform answer text under its first line", () => {
    const { tool } = register();
    const args = {
      question: "Choose?",
      options: [{ label: "Alpha" }],
      allowMultiple: true,
      allowFreeform: true,
    };
    const context = { state: {}, args, lastComponent: undefined };
    tool.renderCall(args, theme(), context);
    const answered = tool.renderResult({
      content: [{ type: "text", text: "Selected: Alpha" }],
      details: {
        status: "answered",
        answer: { selections: [{ option: 0 }], freeform: "one two three four five six seven eight nine" },
      },
    }, {}, theme(), context);

    const lines = answered.render(20);
    const firstFreeformLine = lines.findIndex((line: string) => line.includes("one"));
    const textIndex = lines[firstFreeformLine].indexOf("one");
    const textColumn = visibleWidth(lines[firstFreeformLine].slice(0, textIndex));
    expect(firstFreeformLine).toBeGreaterThan(-1);
    expect(lines[firstFreeformLine + 1]).toMatch(new RegExp(`^ {${textColumn}}\\S`));
  });

  it("renders an explicitly supplied positive timeout in pending metadata", () => {
    const { tool } = register();
    const styledTheme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as any;
    const timeoutContext = { state: {}, args: { question: "Choose?", options: [{ label: "Yes" }], timeout: 1500 }, lastComponent: undefined };
    expect(tool.renderCall(timeoutContext.args, styledTheme, timeoutContext).render(80).join("\n")).toContain("timeout:1.5s");

    const zeroContext = { state: {}, args: { question: "Choose?", options: [{ label: "Yes" }], timeout: 0 }, lastComponent: undefined };
    expect(tool.renderCall(zeroContext.args, styledTheme, zeroContext).render(80).join("\\n")).not.toContain("timeout:");
  });

  it("normalizes without mutating the questionnaire and uses custom TUI", async () => {
    const { tool, emit } = register();
    const params = { question: "  Choose?  ", options: [{ label: " Yes " }], allowFreeform: false };
    const custom = vi.fn(async (factory, options) => {
      expect(options).toBeUndefined();
      let completed: unknown;
      const component = await factory({ requestRender: vi.fn() }, theme(), keybindings(), (value: unknown) => { completed = value; });
      component.handleInput("\r");
      return completed;
    });

    const result = await tool.execute("id", params, undefined, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(result.details).toEqual({ status: "answered", answer: { selections: [{ option: 0 }] } });
    expect(params).toEqual({ question: "  Choose?  ", options: [{ label: " Yes " }], allowFreeform: false });
    expect(emit).toHaveBeenCalledWith("ask:answered", result.details);
  });

  it("returns unanswered when a TUI questionnaire timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const { tool, emit } = register();
      const custom = pendingTui();
      const execution = tool.execute(
        "id",
        { question: "Continue?", options: [{ label: "Yes" }], allowFreeform: false, timeout: 25 },
        undefined,
        undefined,
        { mode: "tui", hasUI: true, ui: { custom } },
      );

      await vi.advanceTimersByTimeAsync(25);
      const result = await execution;
      expect(result.details).toEqual({ status: "unanswered" });
      expect(emit).toHaveBeenCalledWith("ask:unanswered", result.details);
      expect(emit).not.toHaveBeenCalledWith("ask:cancelled", expect.anything());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["answer", "cancel"])("disposes the complete-path timeout after %s", async action => {
    vi.useFakeTimers();
    try {
      const { tool } = register();
      const custom = vi.fn(async (factory: any) => {
        let completed: unknown;
        const component = factory({ requestRender: vi.fn() }, theme(), keybindings(), (value: unknown) => { completed = value; });
        component.handleInput(action === "answer" ? "\r" : "\x1b");
        return completed;
      });
      const result = await tool.execute(
        "id",
        { question: "Continue?", options: [{ label: "Yes" }], allowFreeform: false, timeout: 100 },
        undefined,
        undefined,
        { mode: "tui", hasUI: true, ui: { custom } },
      );
      expect(result.details.status).toBe(action === "answer" ? "answered" : "cancelled");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the configured environment timeout for RPC dialogs", async () => {
    vi.useFakeTimers();
    try {
      await withTimeoutEnv("40", async () => {
        const { tool } = register();
        let inputCalls = 0;
        const input = vi.fn().mockImplementation((_title: string, _placeholder: string | undefined, options?: { signal?: AbortSignal }) => {
          inputCalls += 1;
          return new Promise<string | undefined>(resolve => {
            options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          });
        });
        const execution = tool.execute(
          "id",
          { question: "Continue?", options: [{ label: "Yes" }], allowMultiple: true },
          undefined,
          undefined,
          { mode: "rpc", hasUI: true, ui: { select: vi.fn(), input } },
        );
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(39);
        expect(inputCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(execution).resolves.toMatchObject({ details: { status: "unanswered" } });
        expect(vi.getTimerCount()).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an explicit timeout override the environment default", async () => {
    vi.useFakeTimers();
    try {
      await withTimeoutEnv("40", async () => {
        const { tool } = register();
        const input = vi.fn().mockImplementation((_title: string, _placeholder: string | undefined, options?: { signal?: AbortSignal }) =>
          new Promise<string | undefined>(resolve => options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true })));
        const execution = tool.execute(
          "id",
          { question: "Continue?", options: [{ label: "Yes" }], allowMultiple: true, timeout: 100 },
          undefined,
          undefined,
          { mode: "rpc", hasUI: true, ui: { select: vi.fn(), input } },
        );
        await vi.advanceTimersByTimeAsync(0);
        let settled = false;
        void execution.then(() => { settled = true; });

        await vi.advanceTimersByTimeAsync(40);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(60);
        await expect(execution).resolves.toMatchObject({ details: { status: "unanswered" } });
        expect(vi.getTimerCount()).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses explicit zero to disable the environment timeout", async () => {
    vi.useFakeTimers();
    try {
      await withTimeoutEnv("10", async () => {
        const { tool } = register();
        let finish!: (value: string | undefined) => void;
        const input = vi.fn().mockImplementation(() => new Promise<string | undefined>(resolve => { finish = resolve; }));
        const execution = tool.execute(
          "id",
          { question: "Continue?", options: [{ label: "Yes" }], allowMultiple: true, timeout: 0 },
          undefined,
          undefined,
          { mode: "rpc", hasUI: true, ui: { select: vi.fn(), input } },
        );
        await vi.advanceTimersByTimeAsync(0);
        let settled = false;
        void execution.then(() => { settled = true; });

        await vi.advanceTimersByTimeAsync(10);
        expect(settled).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        finish(undefined);
        await expect(execution).resolves.toMatchObject({ details: { status: "cancelled" } });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a timeout for the no-UI early return", async () => {
    vi.useFakeTimers();
    try {
      const { tool } = register();
      await expect(tool.execute(
        "id",
        { question: "Continue?", options: [{ label: "Yes" }], timeout: 25 },
        undefined,
        undefined,
        { mode: "print", hasUI: false, ui: {} },
      )).resolves.toMatchObject({ details: { status: "ui_unavailable" } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out RPC comment collection with one shared deadline signal", async () => {
    vi.useFakeTimers();
    try {
      const { tool } = register();
      const signals: AbortSignal[] = [];
      let inputCalls = 0;
      const input = vi.fn().mockImplementation((_title: string, _placeholder: string | undefined, options?: { signal?: AbortSignal }) => {
        if (options?.signal) signals.push(options.signal);
        inputCalls += 1;
        if (inputCalls === 1) return Promise.resolve("1");
        return new Promise<string | undefined>(resolve => options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
      });
      const execution = tool.execute(
        "id",
        { question: "Choose?", options: [{ label: "Yes" }], allowMultiple: true, allowFreeform: false, timeout: 30 },
        undefined,
        undefined,
        { mode: "rpc", hasUI: true, ui: { select: vi.fn(), input } },
      );

      await vi.advanceTimersByTimeAsync(30);
      await expect(execution).resolves.toMatchObject({ details: { status: "unanswered" } });
      expect(inputCalls).toBe(2);
      expect(new Set(signals).size).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses RPC dialogs in RPC mode", async () => {
    const { tool } = register();
    const ui = rpcUi();
    const result = await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }] }, undefined, undefined, { mode: "rpc", hasUI: true, ui });
    expect(result.details.status).toBe("answered");
    expect(ui.select).toHaveBeenCalled();
  });

  it("threads parent cancellation through RPC and clears the complete-path deadline", async () => {
    vi.useFakeTimers();
    try {
      await withTimeoutEnv("100", async () => {
        const { tool } = register();
        const controller = new AbortController();
        const ui = rpcUi("1. Yes");
        ui.select.mockImplementation(async (_title, _options, dialogOptions) => {
          expect(dialogOptions?.signal).toBeDefined();
          expect(dialogOptions?.signal).not.toBe(controller.signal);
          controller.abort();
          expect(dialogOptions?.signal?.aborted).toBe(true);
          return "1. Yes";
        });
        const result = await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }] }, controller.signal, undefined, { mode: "rpc", hasUI: true, ui });
        expect(result.details.status).toBe("cancelled");
        expect(ui.input).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns unavailable without throwing or emitting cancellation", async () => {
    const { tool, emit } = register();
    const result = await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }] }, undefined, undefined, { mode: "print", hasUI: false, ui: {} });
    expect(result.details).toEqual({ status: "ui_unavailable" });
    expect(emit).not.toHaveBeenCalledWith("ask:cancelled", expect.anything());
  });

  it.each([
    ["normal answer", false],
    ["cancellation", true],
  ])("removes the TUI abort listener after %s", async (_label, cancel) => {
    const { tool } = register();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const custom = vi.fn(async (factory) => {
      let completed: unknown;
      const component = factory({ requestRender: vi.fn() }, theme(), keybindings(), (value: unknown) => { completed = value; });
      if (cancel) component.handleInput("\x1b");
      else component.handleInput("\r");
      return completed;
    });
    await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }], allowFreeform: false }, controller.signal, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  });

  it("preserves pre-aborted TUI behavior without retaining a listener", async () => {
    const { tool } = register();
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const custom = vi.fn((factory) => new Promise((resolve) => factory({ requestRender: vi.fn() }, theme(), keybindings(), resolve)));
    const result = await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }] }, controller.signal, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(result.details.status).toBe("cancelled");
    expect(add).not.toHaveBeenCalled();
  });

  it("wires cancellation and abort to a structured cancelled result", async () => {
    const { tool, emit } = register();
    const controller = new AbortController();
    const custom = vi.fn((factory) => new Promise((resolve) => {
      factory({ requestRender: vi.fn() }, theme(), keybindings(), resolve);
      controller.abort();
    }));
    const result = await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }] }, controller.signal, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(result.details.status).toBe("cancelled");
    expect(emit).toHaveBeenCalledWith("ask:cancelled", result.details);
  });

  it.each(["direct", "summary", "tool-result"])("replays a %s ask selection and immediately continues", async kind => {
    const { handlers, sendMessage, emit } = register();
    const ask = assistantEntry("ask-entry");
    const result = { type: "message", id: "result", parentId: "ask-entry", timestamp: "now", message: { role: "toolResult", toolCallId: "call-1", toolName: "ask" } };
    const summary = { type: "branch_summary", id: "summary", parentId: "ask-entry", timestamp: "now", fromId: "x", summary: "s" };
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory({ requestRender: vi.fn() }, theme(), keybindings(), (value: unknown) => { result = value; });
      component.handleInput("\r");
      return result;
    });
    await handlers.get("session_tree")(
      { type: "session_tree", oldLeafId: "old", newLeafId: kind === "direct" ? "ask-entry" : kind === "summary" ? "summary" : "result", ...(kind === "summary" ? { summaryEntry: summary } : {}) },
      { mode: "tui", ui: { custom, notify: vi.fn() }, sessionManager: { getBranch: () => [ask, ...(kind === "summary" ? [summary] : kind === "tool-result" ? [result] : [])] } },
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "ask:reanswer", content: "", display: false,
      details: { toolCallId: "call-1", answer: { selections: [{ option: 0 }] } },
    }), { triggerTurn: true, deliverAs: "followUp" });
    expect(emit).not.toHaveBeenCalledWith("ask:reanswered", expect.anything());
    await handlers.get("agent_settled")({}, {});
    expect(emit).toHaveBeenCalledWith("ask:reanswered", expect.objectContaining({ toolCallId: "call-1" }));
  });

  it("updates the original tool row with a hidden revised answer", async () => {
    const { tool, handlers, sendMessage } = register();
    const args = { question: "Choose?", options: [{ label: "Yes" }, { label: "No" }], allowFreeform: false };
    const ask = assistantEntry("ask-entry", [{ name: "ask", arguments: args }]);
    const invalidate = vi.fn();
    const renderContext = { state: {}, args, lastComponent: undefined, toolCallId: "call-1", invalidate };
    tool.renderCall(args, theme(), renderContext);
    const nativeResult = {
      content: [{ type: "text", text: "Selected: Yes" }],
      details: { status: "answered", answer: { selections: [{ option: 0 }] } },
    };
    expect(tool.renderResult(nativeResult, {}, theme(), renderContext).render(80).join("\n")).toContain("󰄴 Yes");

    const custom = vi.fn(async (factory: any) => {
      let answer: unknown;
      const component = factory({ requestRender: vi.fn() }, theme(), keybindings(), (value: unknown) => { answer = value; });
      component.handleInput("\x1b[B");
      component.handleInput("\r");
      return answer;
    });
    await handlers.get("session_tree")(
      { newLeafId: "ask-entry" },
      { mode: "tui", ui: { custom, notify: vi.fn() }, sessionManager: { getBranch: () => [ask] } },
    );

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ display: false }), expect.anything());
    expect(invalidate).toHaveBeenCalled();
    const revised = tool.renderResult(nativeResult, {}, theme(), renderContext).render(80).join("\n");
    expect(revised).toContain("󰄰 Yes");
    expect(revised).toContain("󰄴 No");
  });

  it("restores hidden revisions into the original tool row", () => {
    const { tool, handlers } = register();
    const args = { question: "Choose?", options: [{ label: "Yes" }, { label: "No" }] };
    handlers.get("session_start")({}, { hasUI: true, sessionManager: { getBranch: () => [{
      type: "custom_message", id: "revision", parentId: null, timestamp: "now",
      customType: "ask:reanswer", content: "", display: false,
      details: { toolCallId: "call-1", answer: { selections: [{ option: 1 }] } },
    }] } });

    const context = { state: {}, args, lastComponent: undefined, toolCallId: "call-1", invalidate: vi.fn() };
    tool.renderCall(args, theme(), context);
    const rendered = tool.renderResult({
      content: [{ type: "text", text: "Selected: Yes" }],
      details: { status: "answered", answer: { selections: [{ option: 0 }] } },
    }, {}, theme(), context).render(80).join("\n");
    expect(rendered).toContain("󰄰 Yes");
    expect(rendered).toContain("󰄴 No");
  });

  it("guards replay after submission until agent settlement, then allows another replay", async () => {
    const { handlers, sendMessage, emit } = register();
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory({ requestRender: vi.fn() }, theme(), keybindings(), (value: unknown) => { result = value; });
      component.handleInput("\r");
      return result;
    });
    const ctx = replayContext([assistantEntry("ask-entry")], custom);

    await handlers.get("session_tree")({ newLeafId: "ask-entry" }, ctx);
    await handlers.get("session_tree")({ newLeafId: "ask-entry" }, ctx);
    expect(custom).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalledWith("ask:reanswered", expect.anything());

    await handlers.get("agent_settled")({}, {});
    expect(emit).toHaveBeenCalledWith("ask:reanswered", expect.anything());
    await handlers.get("session_tree")({ newLeafId: "ask-entry" }, ctx);
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it("cleans up the replay guard when message delivery throws", async () => {
    const { handlers, sendMessage, emit } = register();
    sendMessage.mockImplementationOnce(() => { throw new Error("delivery failed"); });
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory({ requestRender: vi.fn() }, theme(), keybindings(), (value: unknown) => { result = value; });
      component.handleInput("\r");
      return result;
    });
    const ctx = replayContext([assistantEntry("ask-entry")], custom);

    await expect(handlers.get("session_tree")({ newLeafId: "ask-entry" }, ctx)).rejects.toThrow("delivery failed");
    await handlers.get("session_tree")({ newLeafId: "ask-entry" }, ctx);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalledWith("ask:reanswered", expect.anything());
  });

  it("does nothing when replay is cancelled", async () => {
    const { handlers, sendMessage, emit } = register();
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory({ requestRender: vi.fn() }, theme(), keybindings(), (value: unknown) => { result = value; });
      component.handleInput("\x1b");
      return result;
    });
    await handlers.get("session_tree")({ newLeafId: "ask-entry" }, replayContext([assistantEntry("ask-entry")], custom));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    ["stored timeout", { question: "Choose?", options: [{ label: "Yes" }], allowFreeform: false, timeout: 25 }, "100"],
    ["environment timeout", { question: "Choose?", options: [{ label: "Yes" }], allowFreeform: false }, "25"],
  ] as const)("applies the %s when re-answering from /tree and disposes it", async (_label, arguments_, envTimeout) => {
    vi.useFakeTimers();
    try {
      await withTimeoutEnv(envTimeout, async () => {
        const { handlers, sendMessage } = register();
        const custom = vi.fn((factory: any) => new Promise(resolve => {
          factory({ requestRender: vi.fn() }, theme(), keybindings(), resolve);
        }));
        const ctx = replayContext([assistantEntry("ask-entry", [{ name: "ask", arguments: arguments_ }])], custom);
        const replay = handlers.get("session_tree")({ newLeafId: "ask-entry" }, ctx);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(25);
        await replay;
        expect(sendMessage).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores unrelated leaves, notifies mixed asks, and guards duplicate events while active", async () => {
    const { handlers, sendMessage } = register();
    const notify = vi.fn();
    const mixed = assistantEntry("mixed", [{ name: "ask", arguments: { question: "Q" } }, { name: "read", arguments: {} }]);
    await handlers.get("session_tree")({ newLeafId: "other" }, { mode: "tui", ui: { notify }, sessionManager: { getBranch: () => [assistantEntry("other", [{ name: "read", arguments: {} }])] } });
    await handlers.get("session_tree")({ newLeafId: "mixed" }, { mode: "tui", ui: { notify }, sessionManager: { getBranch: () => [mixed] } });
    expect(notify).toHaveBeenCalledOnce();

    let finish!: (value: null) => void;
    const custom = vi.fn(() => new Promise<null>(resolve => { finish = resolve; }));
    const ctx = replayContext([assistantEntry("ask-entry")], custom);
    const first = handlers.get("session_tree")({ newLeafId: "ask-entry" }, ctx);
    await Promise.resolve();
    const duplicate = handlers.get("session_tree")({ newLeafId: "ask-entry" }, ctx);
    finish(null);
    await Promise.all([first, duplicate]);
    expect(custom).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])("projects native and replay asks as summaries with intervening summary=%s", (withSummary) => {
    const { contextHandler } = register();
    const firstCall = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: { question: "Choose?", options: [{ label: "Yes" }] } }] };
    const laterCall = { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "ask", arguments: { question: "Later?", options: [{ label: "Later" }] } }] };
    const laterResult = { role: "toolResult", toolCallId: "call-2", toolName: "ask", content: [{ type: "text", text: "verbose" }], details: { status: "answered", answer: { selections: [{ option: 0 }] } }, isError: false, timestamp: 43 };
    const marker = { role: "custom", customType: "ask:reanswer", content: "", timestamp: 42, details: { toolCallId: "call-1", answer: { selections: [{ option: 0 }] } } };
    const branchSummary = { role: "branchSummary", content: "Earlier branch" };
    const messages = [firstCall, ...(withSummary ? [branchSummary] : []), laterCall, laterResult, marker];

    const rewritten = contextHandler({ messages }).messages as any[];
    expect(rewritten).toHaveLength(withSummary ? 3 : 2);
    expect(rewritten[0]).toMatchObject({ role: "custom", customType: "ask:summary", display: false, timestamp: 42 });
    expect(JSON.parse(rewritten[0].content)).toEqual({
      type: "ask_response", question: "Choose?", selectionMode: "single", answer: { selections: [{ label: "Yes" }] },
    });
    if (withSummary) expect(rewritten[1]).toEqual(branchSummary);
    const laterSummary = rewritten[withSummary ? 2 : 1];
    expect(laterSummary).toMatchObject({ role: "custom", customType: "ask:summary", display: false, timestamp: expect.any(Number) });
    expect(JSON.parse(laterSummary.content)).toEqual({
      type: "ask_response", question: "Later?", selectionMode: "single", answer: { selections: [{ label: "Later" }] },
    });
  });

  it("projects a durable replay through the canonical context adapter", () => {
    const { contextHandler } = register();
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: { question: "  Choose?  ", context: "  Release  ", options: [{ label: "  Yes  " }, { label: " No " }] } }] },
      { role: "custom", customType: "ask:reanswer", content: "", timestamp: 77, details: { toolCallId: "call-1", answer: { selections: [{ option: 0 }] } } },
    ];
    const rewritten = contextHandler({ messages }).messages as any[];
    expect(rewritten).toEqual([{
      role: "custom",
      customType: "ask:summary",
      display: false,
      content: JSON.stringify({
        type: "ask_response",
        question: "Choose?",
        context: "Release",
        selectionMode: "single",
        answer: { selections: [{ label: "Yes" }] },
      }),
      timestamp: 77,
    }]);
  });
});

function assistantEntry(id: string, calls: Array<{ name: string; arguments: unknown }> = [{ name: "ask", arguments: { question: "Choose?", options: [{ label: "Yes" }] } }]) {
  return { type: "message", id, parentId: null, timestamp: "now", message: { role: "assistant", content: calls.map((call, index) => ({ type: "toolCall", id: `call-${index + 1}`, ...call })) } };
}

function replayContext(entries: any[], custom: any) {
  return { mode: "tui", ui: { custom, notify: vi.fn() }, sessionManager: { getBranch: () => entries } };
}

function theme() {
  return { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as any;
}
