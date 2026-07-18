import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";
import { SubagentOverlayComponent, type OverlayOptions } from "../../src/command/components/overlay.js";
import { fakeAgent } from "../helpers/fake-agent.js";

function overlay(conversations: any[], overrides: Partial<OverlayOptions> = {}) {
  const callbacks = { notify: vi.fn(), onStart: vi.fn(), onResume: vi.fn(), onRemove: vi.fn(), onSettingsChange: vi.fn() };
  const manager = { listConversations: () => conversations, onAgentUpdate: () => () => {} };
  const component = new SubagentOverlayComponent(manager as any, { requestRender() {} } as any, {} as any, undefined, vi.fn(), {
    initialPage: "conversations", agents: [{ name: "worker", description: "Works", source: "project" } as any], settings: DEFAULT_SUBAGENT_SETTINGS,
    ...callbacks, ...overrides,
  });
  component.focused = true;
  return { component, callbacks };
}

describe("subagent overlay behavior", () => {
  it("opens terminal output by default and resumes only through the rendered resume action", () => {
    const conversation = fakeAgent({ conversationId: "conversation-1", runId: "run-1", status: { kind: "completed", response: "finished output" }, capabilities: { canResume: true } });
    const { component, callbacks } = overlay([conversation]);
    expect(component.render(100).join("\n")).toContain("[r] resume");
    component.handleInput("\r");
    expect(component.render(100).join("\n")).toContain("finished output");
    expect(callbacks.onResume).not.toHaveBeenCalled();
    component.handleInput("r");
    component.handleInput("follow up"); component.handleInput("\r");
    expect(callbacks.onResume).toHaveBeenCalledWith("conversation-1", "follow up");
  });

  it("keeps the resume target fixed while composing and rejects a stale target", () => {
    const first = fakeAgent({ conversationId: "conversation-1", createdAt: 1, capabilities: { canResume: true } });
    const second = fakeAgent({ conversationId: "conversation-2", createdAt: 2, capabilities: { canResume: true } });
    const conversations = [first, second];
    const { component, callbacks } = overlay(conversations);

    component.handleInput("r");
    conversations.reverse();
    component.handleInput("follow up"); component.handleInput("\r");
    expect(callbacks.onResume).toHaveBeenCalledWith("conversation-1", "follow up");

    callbacks.onResume.mockClear();
    component.handleInput("r");
    conversations.splice(0, 1);
    component.handleInput("stale follow up"); component.handleInput("\r");
    expect(callbacks.onResume).not.toHaveBeenCalled();
    expect(callbacks.notify).toHaveBeenCalledWith("Conversation is no longer available to resume.", "warning");
  });

  it("does not offer or invoke resume for active and nonresumable runs", () => {
    for (const conversation of [
      fakeAgent({ status: { kind: "running" }, capabilities: { canResume: true } }),
      fakeAgent({ status: { kind: "completed" }, capabilities: { canResume: false } }),
    ]) {
      const { component, callbacks } = overlay([conversation]);
      expect(component.render(100).join("\n")).not.toContain("[r] resume");
      component.handleInput("r"); component.handleInput("prompt"); component.handleInput("\r");
      expect(callbacks.onResume).not.toHaveBeenCalled();
    }
  });

  it("invokes remove, start, and settings callbacks from keyboard actions", () => {
    const { component, callbacks } = overlay([fakeAgent({ capabilities: { canRemove: true } })]);
    component.handleInput("x");
    expect(callbacks.onRemove).toHaveBeenCalledWith("c1");
    component.handleInput("\t"); // settings
    component.handleInput("\x1b[B"); component.handleInput("\x1b[B"); component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(callbacks.onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "maxConcurrentSubagents" }));
    component.handleInput("\t"); // agents
    component.handleInput("s"); component.handleInput("do work"); component.handleInput("\r");
    expect(callbacks.onStart).toHaveBeenCalledWith("worker", "do work");
  });
});
