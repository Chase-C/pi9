import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";
import { SubagentOverlayComponent, type OverlayOptions } from "../../src/command/overlay.js";
import { fakeAgent, fakeRunSection } from "../helpers/fake-agent.js";

function overlay(conversations: any[], overrides: Partial<OverlayOptions> = {}) {
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const requestRender = vi.fn();
  const callbacks = {
    notify: vi.fn(),
    onStart: vi.fn(),
    onResume: vi.fn(),
    onRemove: vi.fn(),
    onSettingsChange: vi.fn(),
  };
  const manager = {
    listConversations: () => conversations,
    onConversationUpdate: (next: () => void) => { listener = next; return unsubscribe; },
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender } as any,
    {} as any,
    undefined,
    vi.fn(),
    {
      initialPage: "conversations",
      agents: [{ name: "worker", description: "Works", source: "project" } as any],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      ...callbacks,
      ...overrides,
    },
  );
  component.focused = true;
  return { component, callbacks, requestRender, unsubscribe, update: () => listener?.() };
}

describe("subagent overlay behavior", () => {
  it("starts an agent from the agent page", () => {
    const { component, callbacks } = overlay([], { initialPage: "agents" });

    component.handleInput("\r");
    component.handleInput("do work");
    component.handleInput("\r");

    expect(callbacks.onStart).toHaveBeenCalledWith("worker", "do work");
  });

  it("keeps the selected conversation stable while the catalog reorders", () => {
    const first = fakeAgent({ conversationId: "conversation-1", canResume: true });
    const second = fakeAgent({ conversationId: "conversation-2", canResume: true });
    const conversations = [first, second];
    const { component, callbacks } = overlay(conversations);

    component.handleInput("\x1b[B");
    conversations.reverse();
    component.handleInput("r");
    component.handleInput("follow up");
    component.handleInput("\r");

    expect(callbacks.onResume).toHaveBeenCalledWith("conversation-2", "follow up");
  });

  it("does not resume active or non-resumable conversations", () => {
    for (const conversation of [
      fakeAgent({ status: { kind: "running" }, canResume: true }),
      fakeAgent({ status: { kind: "completed" }, canResume: false }),
    ]) {
      const { component, callbacks } = overlay([conversation]);
      component.handleInput("r");
      component.handleInput("prompt");
      component.handleInput("\r");
      expect(callbacks.onResume).not.toHaveBeenCalled();
    }
  });

  it("removes the selected conversation", () => {
    const { component, callbacks } = overlay([fakeAgent({ conversationId: "conversation-1" })]);
    component.handleInput("x");
    expect(callbacks.onRemove).toHaveBeenCalledWith("conversation-1");
  });

  it("rerenders on manager updates and unsubscribes on disposal", () => {
    const { component, requestRender, unsubscribe, update } = overlay([]);
    update();
    expect(requestRender).toHaveBeenCalled();
    component.dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("renders wide and narrow views without throwing", () => {
    const { component } = overlay([fakeAgent()]);
    expect(() => component.render(120)).not.toThrow();
    expect(() => component.render(56)).not.toThrow();
  });

  it("renders conversation chronology with compact previous-run statistics", () => {
    const previous = fakeRunSection({
      runId: "scan-deeply",
      prompt: "Initial risk scan",
      turns: 3,
      compactions: 1,
      activeTools: ["read", "grep", "read", "grep", "read"],
    });
    const conversation = fakeAgent({
      conversationId: "amber-fox",
      runId: "inspect-carefully",
      label: "risk review",
      prompt: "Review session handling.",
      turns: 4,
      activeTools: ["read", "grep"],
      previousRuns: [previous],
      status: { kind: "completed", response: "Final findings." },
    });
    const { component } = overlay([conversation]);
    const output = component.render(120).map(line => line.trimEnd()).join("\n");

    expect(output).toContain("Previous runs");
    expect(output).toContain("risk review · scan-deeply · 3 turns · 5 tools · 1 compaction");
    expect(output).not.toContain("run scan-deeply");
    expect(output).not.toContain("spawn · completed");
    expect(output.indexOf("Previous runs")).toBeLessThan(output.indexOf("Current prompt"));
    expect(output.indexOf("Current prompt")).toBeLessThan(output.indexOf("Activity"));
    expect(output.indexOf("Activity")).toBeLessThan(output.indexOf("Final output"));
    expect(output).toContain("Final findings.");
  });

  it("renders unlabelled, unindented agent instructions below metadata", () => {
    const agent = {
      name: "scout",
      description: "A long agent description that should wrap naturally instead of being indented as subordinate metadata.",
      source: "project",
      model: "anthropic/sonnet",
      thinking: "medium",
      tools: ["read", "grep"],
      systemPrompt: "Inspect the repository without modifying files.\n\nReturn evidence-backed findings.",
    } as any;
    const { component } = overlay([], { initialPage: "agents", agents: [agent] });
    const output = component.render(120).map(line => line.trimEnd()).join("\n");

    expect(output).not.toContain("Instructions");
    expect(output).toContain("model anthropic/sonnet · thinking medium");
    expect(output).toContain("│  Inspect the repository without modifying files.");
    expect(output).toContain("Return evidence-backed findings.");
  });
});
