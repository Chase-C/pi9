import { describe, expect, it, vi } from "vitest";
import askExtension from "../src/index.js";

function register() {
  let tool: any;
  const handlers = new Map<string, any>();
  const emit = vi.fn();
  const sendMessage = vi.fn();
  const registerMessageRenderer = vi.fn();
  askExtension({
    registerTool: (definition: unknown) => { tool = definition; },
    registerMessageRenderer,
    sendMessage,
    on: (event: string, handler: unknown) => { handlers.set(event, handler); },
    events: { emit },
  } as never);
  const contextHandler = handlers.get("context");
  if (!tool || !contextHandler) throw new Error("ask integration was not registered");
  return { tool, contextHandler, handlers, emit, sendMessage, registerMessageRenderer };
}

const rpcUi = (answer = "1. Yes") => ({
  select: vi.fn().mockResolvedValue(answer),
  input: vi.fn().mockResolvedValue(""),
});

describe("ask extension integration", () => {
  it("registers the strict sequential tool, guidance, renderers, and context pruning", () => {
    const { tool, contextHandler } = register();
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.executionMode).toBe("sequential");
    expect(tool.promptGuidelines.join(" ").length).toBeLessThan(240);
    expect(tool.renderCall({ question: "Choose?" }, theme(), {}).render(80).join("\n")).toContain("Choose?");
    expect(tool.renderResult({ content: [{ type: "text", text: "Selected: Yes" }] }, {}, theme(), {}).render(80).join("\n")).toContain("Selected: Yes");

    const details = { status: "answered", question: "Choose", answer: { selections: [{ label: "Yes" }] } };
    const messages: any[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "ask", arguments: { question: "Choose", options: [{ label: "Yes" }, { label: "No" }] } }, { type: "toolCall", id: "alternative", name: "other", arguments: {} }] },
      { role: "toolResult", toolCallId: "a", toolName: "ask", details, content: [{ type: "text", text: "original verbose result" }] },
    ];
    const rewritten = contextHandler({ messages }).messages;
    expect(rewritten[0].content[0].arguments.options).toEqual([{ label: "Yes" }]);
    expect(rewritten[1].content).toEqual([{ type: "text", text: "Selected: Yes" }]);
    expect(rewritten[1].details).toEqual(details);
    expect(messages[0].content[0].arguments.options).toHaveLength(2);
    expect(messages[0].content[1].id).toBe("alternative");
    expect(messages[1].details).toBe(details);
  });

  it("normalizes without mutating the questionnaire and uses the full TUI overlay", async () => {
    const { tool, emit } = register();
    const params = { question: "  Choose?  ", options: [{ label: " Yes " }], allowFreeform: false };
    const custom = vi.fn(async (factory, options) => {
      expect(options).toMatchObject({ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" } });
      let completed: unknown;
      const component = await factory({ requestRender: vi.fn() }, theme(), {}, (value: unknown) => { completed = value; });
      component.handleInput("\r");
      return completed;
    });

    const result = await tool.execute("id", params, undefined, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(result.details).toEqual({ status: "answered", question: "Choose?", answer: { selections: [{ label: "Yes" }] } });
    expect(params).toEqual({ question: "  Choose?  ", options: [{ label: " Yes " }], allowFreeform: false });
    expect(emit).toHaveBeenCalledWith("ask:answered", result.details);
  });

  it.each(["rpc", "tui"])("uses RPC dialogs in %s mode when rich UI is unavailable", async (mode) => {
    const { tool } = register();
    const ui = rpcUi();
    if (mode === "tui") Object.assign(ui, { custom: vi.fn().mockResolvedValue(undefined) });
    const result = await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }] }, undefined, undefined, { mode, hasUI: true, ui });
    expect(result.details.status).toBe("answered");
    expect(ui.select).toHaveBeenCalled();
  });

  it("threads cancellation through RPC and returns a structured cancelled result", async () => {
    const { tool } = register();
    const controller = new AbortController();
    const ui = rpcUi("1. Yes");
    ui.select.mockImplementation(async (_title, _options, dialogOptions) => {
      expect(dialogOptions).toEqual({ signal: controller.signal });
      controller.abort();
      return "1. Yes";
    });
    const result = await tool.execute("id", { question: "Continue?", options: [{ label: "Yes" }] }, controller.signal, undefined, { mode: "rpc", hasUI: true, ui });
    expect(result.details.status).toBe("cancelled");
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("returns unavailable without throwing or emitting cancellation", async () => {
    const { tool, emit } = register();
    const result = await tool.execute("id", { question: "Continue?" }, undefined, undefined, { mode: "print", hasUI: false, ui: {} });
    expect(result.details).toEqual({ status: "ui_unavailable", question: "Continue?" });
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
      const component = factory({ requestRender: vi.fn() }, theme(), {}, (value: unknown) => { completed = value; });
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
    const custom = vi.fn((factory) => new Promise((resolve) => factory({ requestRender: vi.fn() }, theme(), {}, resolve)));
    const result = await tool.execute("id", { question: "Continue?" }, controller.signal, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(result.details.status).toBe("cancelled");
    expect(add).not.toHaveBeenCalled();
  });

  it("wires cancellation and abort to a structured cancelled result", async () => {
    const { tool, emit } = register();
    const controller = new AbortController();
    const custom = vi.fn((factory) => new Promise((resolve) => {
      factory({ requestRender: vi.fn() }, theme(), {}, resolve);
      controller.abort();
    }));
    const result = await tool.execute("id", { question: "Continue?" }, controller.signal, undefined, { mode: "tui", hasUI: true, ui: { custom } });
    expect(result.details.status).toBe("cancelled");
    expect(emit).toHaveBeenCalledWith("ask:cancelled", result.details);
  });

  it.each(["direct", "summary"])("replays a %s ask selection and immediately continues", async kind => {
    const { handlers, sendMessage, emit, registerMessageRenderer } = register();
    expect(registerMessageRenderer).toHaveBeenCalledWith("ask:reanswer", expect.any(Function));
    const ask = assistantEntry("ask-entry");
    const summary = { type: "branch_summary", id: "summary", parentId: "ask-entry", timestamp: "now", fromId: "x", summary: "s" };
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory({ requestRender: vi.fn() }, theme(), {}, (value: unknown) => { result = value; });
      component.handleInput("\r");
      return result;
    });
    await handlers.get("session_tree")(
      { type: "session_tree", oldLeafId: "old", newLeafId: kind === "direct" ? "ask-entry" : "summary", ...(kind === "summary" ? { summaryEntry: summary } : {}) },
      { mode: "tui", ui: { custom, notify: vi.fn() }, sessionManager: { getBranch: () => [ask, ...(kind === "summary" ? [summary] : [])] } },
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "ask:reanswer", display: true,
      details: expect.objectContaining({ version: 1, toolCallId: "call-1", question: "Choose?", allowMultiple: false, answer: { cancelled: false, selections: [{ label: "Yes" }] } }),
    }), { triggerTurn: true, deliverAs: "followUp" });
    expect(emit).not.toHaveBeenCalledWith("ask:reanswered", expect.anything());
    await handlers.get("agent_settled")({}, {});
    expect(emit).toHaveBeenCalledWith("ask:reanswered", expect.objectContaining({ question: "Choose?" }));
  });

  it("guards replay after submission until agent settlement, then allows another replay", async () => {
    const { handlers, sendMessage, emit } = register();
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory({ requestRender: vi.fn() }, theme(), {}, (value: unknown) => { result = value; });
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
      const component = factory({ requestRender: vi.fn() }, theme(), {}, (value: unknown) => { result = value; });
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
      const component = factory({ requestRender: vi.fn() }, theme(), {}, (value: unknown) => { result = value; });
      component.handleInput("\x1b");
      return result;
    });
    await handlers.get("session_tree")({ newLeafId: "ask-entry" }, replayContext([assistantEntry("ask-entry")], custom));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
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

  it.each([false, true])("restores later native Ask details by tool-call identity with intervening summary=%s", (withSummary) => {
    const { contextHandler } = register();
    const nativeDetails = { status: "answered", question: "Later?", answer: { selections: [{ label: "Later" }] } };
    const firstCall = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: { question: "Choose?", options: [{ label: "Yes" }] } }] };
    const laterCall = { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "ask", arguments: { question: "Later?", options: [{ label: "Later" }] } }] };
    const laterResult = { role: "toolResult", toolCallId: "call-2", toolName: "ask", content: [{ type: "text", text: "verbose" }], details: nativeDetails };
    const marker = { role: "custom", customType: "ask:reanswer", content: "Replay", timestamp: 42, details: { version: 1, toolCallId: "call-1", question: "Choose?", allowMultiple: false, answer: { cancelled: false, selections: [{ label: "Yes" }] } } };
    const summary = { role: "branchSummary", content: "Earlier branch" };
    const messages = [firstCall, ...(withSummary ? [summary] : []), laterCall, laterResult, marker];

    const rewritten = contextHandler({ messages }).messages as any[];
    const projectedNative = rewritten.find(message => message.toolCallId === "call-2");
    expect(projectedNative.details).toEqual(nativeDetails);
    expect(rewritten.find(message => message.content?.some?.((item: any) => item.id === "call-2")).details).toBeUndefined();
    expect(rewritten.map(message => message.toolCallId ?? message.content?.[0]?.id ?? message.role)).toEqual(
      withSummary
        ? ["call-1", "call-1", "branchSummary", "call-2", "call-2"]
        : ["call-1", "call-1", "call-2", "call-2"],
    );
  });

  it("projects a durable replay through the canonical context adapter", () => {
    const { contextHandler } = register();
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: { question: "  Choose?  ", context: "  Release  ", options: [{ label: "  Yes  " }, { label: " No " }] } }] },
      { role: "custom", customType: "ask:reanswer", content: "Re-answer: Choose?", timestamp: 77, details: { version: 1, toolCallId: "call-1", question: "Choose?", context: "Release", allowMultiple: false, answer: { cancelled: false, selections: [{ label: "Yes" }] } } },
    ];
    const rewritten = contextHandler({ messages }).messages;
    expect(rewritten[0].content[0].arguments).toEqual({ question: "Choose?", context: "Release", options: [{ label: "Yes" }] });
    expect(rewritten[1]).toMatchObject({ role: "toolResult", toolCallId: "call-1", details: { cancelled: false, selections: [{ label: "Yes" }] }, isError: false, timestamp: 77 });
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
