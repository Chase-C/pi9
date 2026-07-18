import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";
import { registerSubagentsCommand } from "../../src/command/register.js";
import { projectConversations } from "../../src/command/overlay-view-model.js";
import { fakeAgent } from "../helpers/fake-agent.js";
describe("subagents command conversation model", () => { it("searches both conversation and run ids", () => { const value = fakeAgent({ conversationId: "conversation-one", runId: "run-one" }); expect(projectConversations([value], { mode: "flat", query: "run-one" })).toHaveLength(1); expect(projectConversations([value], { mode: "flat", query: "conversation-one" })).toHaveLength(1); }); });

describe("subagents command registration", () => {
  it("applies runtime settings before a subsequent start and persists them", async () => {
    let handler: any; let component: any;
    const configure = vi.fn(); const startRun = vi.fn(() => ({ starts: [{ ok: true, conversationId: "c2", runId: "r2" }] }));
    const manager = { configure, startRun, listConversations: () => [], onAgentUpdate: () => () => {}, removeConversation: vi.fn() };
    const save = vi.fn(async () => {});
    const pi = { registerCommand: (_name: string, registration: any) => { handler = registration.handler; } };
    registerSubagentsCommand(pi as any, manager as any, { load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }), save });
    const ctx = { hasUI: true, ui: { custom: async (factory: any) => { component = factory({ requestRender() {} }, {}, undefined, () => {}); } } };
    await handler("settings", ctx);
    component.handleInput("\x1b[B"); component.handleInput("\x1b[B"); component.handleInput("\x1b[B"); component.handleInput("\r");
    component.options.onStart("worker", "work");
    expect(configure).toHaveBeenLastCalledWith({ maxRunning: 8, maxConversations: 100 });
    expect(configure.mock.invocationCallOrder.at(-1)).toBeLessThan(startRun.mock.invocationCallOrder[0]);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ maxConcurrentSubagents: 8 }) }));
  });

  it("reports asynchronous settings save failures", async () => {
    let handler: any; let component: any; const notify = vi.fn();
    const manager = { configure: vi.fn(), listConversations: () => [], onAgentUpdate: () => () => {} };
    registerSubagentsCommand({ registerCommand: (_n: string, r: any) => { handler = r.handler; } } as any, manager as any, { load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }), save: async () => { throw new Error("disk full"); } });
    await handler("settings", { hasUI: true, ui: { notify, custom: async (factory: any) => { component = factory({ requestRender() {} }, {}, undefined, () => {}); } } });
    component.handleInput("\r");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Could not save subagent settings: disk full", "warning"));
  });
});
