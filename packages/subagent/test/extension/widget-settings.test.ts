import { expect, test, vi } from "vitest";

import subagentExtension from "../../src/index.js";
import { createDefaultSubagentSettings } from "../../src/settings.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("extension reconciles completion messages at the provider context boundary", () => {
  const handlers = new Map<string, (event: any) => any>();
  const completed: any = fakeAgent({ status: { kind: "done", outcome: "completed", completedAt: 2 } });
  completed.runs[0] = { ...completed.runs[0], acknowledged: true };
  const runtime = {
    scheduler: { setChildTool: vi.fn(), setChildSessionEvent: vi.fn() },
    listConversations: () => [completed],
    onConversationUpdate: () => () => {},
  };

  subagentExtension({
    on: (event: string, handler: (event: any) => any) => { handlers.set(event, handler); },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
  } as any, {
    runtime: runtime as any,
    agentRegistry: { agents: new Map() } as any,
    settingsStore: { load: async () => ({ settings: createDefaultSubagentSettings() }), save: async () => {} },
  });

  const completion = {
    role: "custom",
    customType: "subagent-completion",
    content: "<subagent-notification/>",
    details: {
      completions: [{
        runId: completed.runs[0].runId,
        conversationId: completed.conversationId,
        agent: completed.config.name,
        status: "completed",
        elapsedMs: 1,
      }],
    },
  };
  expect(handlers.get("context")?.({ messages: [completion] })).toEqual({ messages: [] });
});

test("loading settings for a tool invocation refreshes the visible widget", async () => {
  let tool: any;
  const runtime = {
    scheduler: { setChildTool: vi.fn(), setChildSessionEvent: vi.fn() },
    configure: vi.fn(),
    listConversations: () => [fakeAgent({ status: { kind: "running", startedAt: 1 } })],
    onConversationUpdate: () => () => {},
  };
  const agentRegistry = { agents: new Map(), reload: async () => {} };
  const settings = createDefaultSubagentSettings();
  const setWidget = vi.fn();
  subagentExtension({
    on: vi.fn(),
    registerTool: (definition: any) => { tool = definition; },
    registerCommand: vi.fn(),
  } as any, {
    runtime: runtime as any,
    agentRegistry: agentRegistry as any,
    settingsStore: { load: async () => ({ settings }), save: async () => {} },
  });

  await tool.execute("call", { action: "agents" }, undefined, undefined, {
    cwd: "/tmp",
    hasUI: true,
    ui: { setWidget },
  });

  expect(setWidget).toHaveBeenCalledWith("subagent", expect.any(Function), { placement: "belowEditor" });
});
