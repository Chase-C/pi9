import { expect, test, vi } from "vitest";

import subagentExtension from "../../src/index.js";
import { createDefaultSubagentSettings } from "../../src/settings.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("loading settings for a tool invocation refreshes the visible widget", async () => {
  let tool: any;
  const runtime = {
    scheduler: { setChildTool: vi.fn() },
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
