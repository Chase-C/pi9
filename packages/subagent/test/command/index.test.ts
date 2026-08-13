import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";
import { registerSubagentsCommand } from "../../src/command/index.js";
import { fakeAgent } from "../helpers/fake-agent.js";

describe("subagents command registration", () => {
  it("applies settings before starting work and persists them", async () => {
    let handler: any;
    const configure = vi.fn();
    const startTasks = vi.fn(() => ({ starts: [{ ok: true, conversationId: "c2", generation: 1 }] }));
    const manager = { configure, startTasks, listConversations: () => [], onConversationUpdate: () => () => {}, removeConversation: vi.fn() };
    const save = vi.fn(async () => {});
    registerSubagentsCommand(
      { registerCommand: (_name: string, registration: any) => { handler = registration.handler; } } as any,
      manager as any,
      { load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }), save },
    );
    const ctx = {
      hasUI: true,
      ui: {
        custom: async (factory: any) => {
          const component = factory({ requestRender() {} }, {}, undefined, () => {});
          component.options.onSettingsChange({ kind: "maxConcurrentSubagents", value: 8 });
          component.options.onStart("worker", "work");
        },
      },
    };

    await handler("settings", ctx);

    expect(configure).toHaveBeenLastCalledWith({ maxExecuting: 8, maxConversations: 100 });
    expect(startTasks).toHaveBeenCalledWith(expect.anything(), [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }], { initiatedBy: "user" });
    expect(configure.mock.invocationCallOrder.at(-1)).toBeLessThan(startTasks.mock.invocationCallOrder[0]);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ maxConcurrentSubagents: 8 }) }));
  });

  it("marks overlay resumes as user-initiated", async () => {
    let handler: any;
    const startTasks = vi.fn(() => ({ starts: [{ ok: true, conversationId: "calm-river", generation: 2 }] }));
    const manager = {
      configure: vi.fn(),
      startTasks,
      listConversations: () => [fakeAgent({ conversationId: "calm-river", receipts: { user: true }, resumeAllowed: true })],
      onConversationUpdate: () => () => {},
      collectSubagentForUser: vi.fn(() => ({ conversationId: "calm-river", generation: 1, collected: true })),
    };
    registerSubagentsCommand(
      { registerCommand: (_name: string, registration: any) => { handler = registration.handler; } } as any,
      manager as any,
      { load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }), save: async () => {} },
    );

    await handler("conversations", {
      hasUI: true,
      ui: {
        custom: async (factory: any) => {
          const component = factory({ requestRender() {} }, {}, undefined, () => {});
          component.options.onResume("calm-river", "continue");
        },
      },
    });

    expect(startTasks).toHaveBeenCalledWith(expect.anything(), [{ kind: "resume", subagentId: "calm-river", prompt: "continue" }], { initiatedBy: "user" });
  });

  it("refreshes the widget when settings open and display settings change", async () => {
    let handler: any;
    const setWidget = vi.fn();
    const manager = {
      configure: vi.fn(),
      listConversations: () => [fakeAgent({ status: { kind: "running", startedAt: 1 } })],
      onConversationUpdate: () => () => {},
    };
    registerSubagentsCommand(
      { registerCommand: (_name: string, registration: any) => { handler = registration.handler; } } as any,
      manager as any,
      { load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }), save: async () => {} },
    );

    await handler("settings", {
      hasUI: true,
      ui: {
        setWidget,
        custom: async (factory: any) => {
          const component = factory({ requestRender() {} }, {}, undefined, () => {});
          component.options.onSettingsChange({ kind: "widgetMode", value: "progress" });
          component.options.onSettingsChange({ kind: "widgetMaxRowsPerSection", value: 8 });
          component.options.onSettingsChange({ kind: "widgetPlacement", value: "aboveEditor" });
        },
      },
    });

    expect(setWidget).toHaveBeenCalledTimes(4);
  });

  it("serializes rapid settings saves", async () => {
    let handler: any;
    const saved: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const manager = { configure: vi.fn(), listConversations: () => [], onConversationUpdate: () => () => {} };
    registerSubagentsCommand(
      { registerCommand: (_name: string, registration: any) => { handler = registration.handler; } } as any,
      manager as any,
      {
        load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }),
        save: async settings => {
          saved.push(settings.runtime.maxConcurrentSubagents);
          if (saved.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
        },
      },
    );
    const handling = handler("settings", {
      hasUI: true,
      ui: {
        custom: async (factory: any) => {
          const component = factory({ requestRender() {} }, {}, undefined, () => {});
          component.options.onSettingsChange({ kind: "maxConcurrentSubagents", value: 8 });
          component.options.onSettingsChange({ kind: "maxConcurrentSubagents", value: 16 });
        },
      },
    });

    await vi.waitFor(() => expect(saved).toEqual([8]));
    releaseFirst?.();
    await handling;
    expect(saved).toEqual([8, 16]);
  });

  it("automatically uses the synchronous user collector without collection notifications or bindings", async () => {
    let handler: any;
    const notify = vi.fn();
    let conversation = fakeAgent({ conversationId: "c1", initiatedBy: "user" });
    const collectSubagentForUser = vi.fn(() => {
      const latest = conversation.generations.at(-1)!;
      conversation = {
        ...conversation,
        generations: [...conversation.generations.slice(0, -1), { ...latest, receipts: { ...latest.receipts, user: true } }],
      };
      return { conversationId: "c1", generation: 1, collected: true };
    });
    const manager = {
      configure: vi.fn(),
      listConversations: () => [conversation],
      onConversationUpdate: () => () => {},
      collectSubagentForUser,
    };
    registerSubagentsCommand(
      { registerCommand: (_name: string, registration: any) => { handler = registration.handler; } } as any,
      manager as any,
      { load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }), save: async () => {} },
    );

    await handler("conversations", {
      hasUI: true,
      ui: {
        notify,
        custom: async (factory: any) => {
          factory({ requestRender() {} }, {}, undefined, () => {});
        },
      },
    });

    expect(collectSubagentForUser).toHaveBeenCalledWith("c1");
    expect(collectSubagentForUser).toHaveReturnedWith({ conversationId: "c1", generation: 1, collected: true });
    expect(conversation.generations.at(-1)).toMatchObject({
      activeCollectionCount: 0,
      receipts: { user: true, model: false },
    });
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Collected"), expect.anything());
  });

  it("reports asynchronous settings save failures", async () => {
    let handler: any;
    const notify = vi.fn();
    const manager = { configure: vi.fn(), listConversations: () => [], onConversationUpdate: () => () => {} };
    registerSubagentsCommand(
      { registerCommand: (_name: string, registration: any) => { handler = registration.handler; } } as any,
      manager as any,
      { load: async () => ({ settings: DEFAULT_SUBAGENT_SETTINGS }), save: async () => { throw new Error("disk full"); } },
    );

    await handler("settings", {
      hasUI: true,
      ui: {
        notify,
        custom: async (factory: any) => {
          const component = factory({ requestRender() {} }, {}, undefined, () => {});
          component.options.onSettingsChange({ kind: "maxConcurrentSubagents", value: 8 });
        },
      },
    });

    expect(notify).toHaveBeenCalledWith("Could not save subagent settings: disk full", "warning");
  });
});
