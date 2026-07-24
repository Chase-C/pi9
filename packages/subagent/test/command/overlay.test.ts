import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";
import { SubagentOverlayComponent, type OverlayOptions } from "../../src/command/overlay.js";
import { fakeAgent, fakeRunSection, ZERO_USAGE } from "../helpers/fake-agent.js";

function overlay(conversations: any[], overrides: Partial<OverlayOptions> = {}, theme: any = {}, terminalRows?: number) {
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
    { requestRender, ...(terminalRows !== undefined ? { terminal: { rows: terminalRows } } : {}) } as any,
    theme,
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

  it("keeps selection on the same conversation when a newer row is inserted above it", () => {
    const first = fakeAgent({ conversationId: "conversation-1", createdAt: 1, canResume: true });
    const second = fakeAgent({ conversationId: "conversation-2", createdAt: 2, canResume: true });
    const conversations = [first, second];
    const { component, callbacks } = overlay(conversations);

    component.handleInput("\x1b[B");
    conversations.push(fakeAgent({ conversationId: "conversation-3", createdAt: 3, canResume: true }));
    component.handleInput("r");
    component.handleInput("follow up");
    component.handleInput("\r");

    expect(callbacks.onResume).toHaveBeenCalledWith("conversation-1", "follow up");
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

  it("renders the title and tabs in a framed header drawer", () => {
    const { component } = overlay([fakeAgent()]);
    const output = component.render(120);

    expect(output[0]).toMatch(/^╭─+╮$/);
    expect(output[1]).toContain("Subagents    [ Agents ]  [ Conversations ]  [ Settings ]");
    expect(output[2]).toMatch(/^├─+┤$/);
  });

  it("keeps complete header and controls within small-terminal height budgets", () => {
    for (const rows of [18, 19]) {
      const { component } = overlay([fakeAgent()], {}, {}, rows);
      const output = component.render(56);

      expect(output).toHaveLength(Math.floor(rows * 0.8));
      expect(output[1]).toContain("Subagents  [ Agents ]  [ Conversations ]  [ Settings ]");
      expect(output.at(-2)).toContain("select");
      expect(output.at(-1)).toMatch(/^╰─+╯$/);
    }
  });

  it("cycles panes backward with shift-tab", () => {
    const { component } = overlay([], {
      initialPage: "agents",
      agents: [{ name: "worker", description: "Works", source: "project", systemPrompt: "Work." } as any],
    });

    component.handleInput("\x1b[Z");
    expect(component.render(120).join("\n")).toContain("Widget placement");

    component.handleInput("\t");
    expect(component.render(120).join("\n")).toContain("worker · project");
  });

  it("renders wide and narrow views without throwing", () => {
    const { component } = overlay([fakeAgent()]);
    expect(() => component.render(120)).not.toThrow();
    expect(() => component.render(56)).not.toThrow();
  });

  it("pins the filter to the bottom of the list pane on both browser pages", () => {
    for (const { component } of [
      overlay([fakeAgent()]),
      overlay([], { initialPage: "agents", agents: [{ name: "worker", description: "Works", source: "project", systemPrompt: "Work." } as any] }),
    ]) {
      const output = component.render(120);
      const divider = output.map(line => line.includes("├")).lastIndexOf(true);
      expect(output[divider - 1]).toContain("/ Filter…");
    }
  });

  it("keeps the selected row visible when scrolling either browser page", () => {
    const conversations = Array.from({ length: 12 }, (_, index) => fakeAgent({ conversationId: `conversation-${index}`, createdAt: 12 - index }));
    const agents = Array.from({ length: 12 }, (_, index) => ({
      name: `agent-${String(index).padStart(2, "0")}`,
      description: `Agent ${index}`,
      source: "project",
      systemPrompt: `Work as agent ${index}.`,
    } as any));

    for (const { component, selected } of [
      { ...overlay(conversations), selected: "conversation-11" },
      { ...overlay([], { initialPage: "agents", agents }), selected: "agent-11" },
    ]) {
      for (let index = 1; index < 12; index++) component.handleInput("\x1b[B");
      const output = component.render(120);
      const divider = output.map(line => line.includes("├")).lastIndexOf(true);
      expect(output.join("\n")).toContain(selected);
      expect(output[divider - 1]).toContain("/ Filter…");
    }
  });

  it("renders stable overflow count rows for agents and conversations", () => {
    const conversations = Array.from({ length: 12 }, (_, index) => fakeAgent({ conversationId: `conversation-${index}` }));
    const agents = Array.from({ length: 12 }, (_, index) => ({
      name: `agent-${String(index).padStart(2, "0")}`,
      description: `Agent ${index}`,
      source: "project",
      systemPrompt: `Work as agent ${index}.`,
    } as any));

    for (const { component } of [
      overlay(conversations),
      overlay([], { initialPage: "agents", agents }),
    ]) {
      const initial = component.render(120);
      const initialBelowLine = initial.findIndex(line => line.includes("▼ 7 more below"));
      expect(initialBelowLine).toBeGreaterThan(0);

      for (let index = 0; index < 3; index++) component.handleInput("\x1b[B");
      const scrolled = component.render(120);
      expect(scrolled.join("\n")).toContain("▲ 1 more above");
      expect(scrolled.join("\n")).toContain("▼ 6 more below");
      expect(scrolled.findIndex(line => line.includes("more below"))).toBe(initialBelowLine);
    }
  });

  it("renders recursive descendants as a one-line tree inside Activity", () => {
    const root = fakeAgent({
      conversationId: "root-conversation",
      runId: "root-run",
      label: "recursive overlay demo",
      createdAt: 1,
      messageSnippet: "ROOT_FINAL_OUTPUT",
      status: { kind: "completed", response: "ROOT_FINAL_OUTPUT" },
    });
    const branchSpawn = fakeRunSection({ runId: "branch-a-run", createdAt: 3 });
    const branchResume = fakeRunSection({ runId: "branch-a-resume", createdAt: 7, kind: "resume" });
    const branchA = fakeAgent({
      conversationId: "branch-a",
      label: "recursive branch A",
      createdAt: 3,
      options: { agent: "recursive-test" },
      parent: { conversationId: "root-conversation", runId: "root-run" },
      runs: [branchSpawn, branchResume],
    });
    const leafA = fakeAgent({
      conversationId: "leaf-a",
      runId: "leaf-a-run",
      label: "leaf branch A1",
      createdAt: 5,
      options: { agent: "recursive-test" },
      parent: { conversationId: "branch-a", runId: "branch-a-run" },
    });
    const resumedLeaf = fakeAgent({
      conversationId: "resumed-leaf",
      runId: "resumed-leaf-run",
      label: "leaf from branch resume",
      createdAt: 8,
      options: { agent: "recursive-test" },
      parent: { conversationId: "branch-a", runId: "branch-a-resume" },
    });
    const branchB = fakeAgent({
      conversationId: "branch-b",
      runId: "branch-b-run",
      label: "recursive branch B",
      createdAt: 2,
      options: { agent: "recursive-test" },
      parent: { conversationId: "root-conversation", runId: "root-run" },
    });
    const { component } = overlay([root, branchA, leafA, resumedLeaf, branchB]);
    const output = component.render(180).join("\n");

    expect(output).toContain("subagents");
    const nested = output.slice(output.indexOf("subagents"));
    expect(nested).toContain("├─ recursive branch A · recursive-test · completed");
    expect(nested).toContain("│  ╰─ leaf branch A1 · recursive-test · completed");
    expect(nested).toContain("╰─ recursive branch B · recursive-test · completed");
    expect(nested).not.toContain("leaf from branch resume");
    expect(output.indexOf("Activity")).toBeLessThan(output.indexOf("subagents"));
    expect(output.match(/ROOT_FINAL_OUTPUT/g)).toHaveLength(1);
    expect(output).toContain("Final output");

    component.handleInput("\x1b[B");
    const resumedOutput = component.render(180).join("\n");
    const resumedNested = resumedOutput.slice(resumedOutput.indexOf("subagents"));
    expect(resumedNested).toContain("╰─ leaf from branch resume · recursive-test · completed");
    expect(resumedNested).not.toContain("leaf branch A1");
  });

  it("renders conversation chronology with compact previous-run statistics", () => {
    const previous = fakeRunSection({
      runId: "scan-deeply",
      prompt: "Initial risk scan",
      turns: 3,
      compactions: 1,
      activeTools: ["read", "grep", "read", "grep", "read"],
      totalUsage: { ...ZERO_USAGE, totalTokens: 1_234 },
    });
    const failed = fakeRunSection({
      runId: "verify-carefully",
      prompt: "Verify the findings",
      status: { kind: "error", error: "Verification failed." },
      totalUsage: { ...ZERO_USAGE, totalTokens: 640 },
    });
    const conversation = fakeAgent({
      conversationId: "amber-fox",
      runId: "inspect-carefully",
      label: "risk review",
      prompt: "Review session handling.",
      turns: 4,
      compactions: 2,
      activeTools: ["read", "grep"],
      totalUsage: { ...ZERO_USAGE, totalTokens: 2_500 },
      previousRuns: [previous, failed],
      status: { kind: "completed", response: "Final findings." },
    });
    const { component } = overlay([conversation]);
    const output = component.render(180).map(line => line.trimEnd()).join("\n");

    expect(output).toContain("Previous runs");
    expect(output).toContain("risk review · scan-deeply · 3 turns · 5 tools · 1 compaction · 1.2k tokens");
    expect(output).toContain("risk review [error] · verify-carefully · 0 turns · 0 tools · 640 tokens");
    expect(output).not.toContain("✓ risk review");
    expect(output).not.toContain("[completed]");
    expect(output).not.toContain("run scan-deeply");
    expect(output).not.toContain("spawn · completed");
    expect(output.indexOf("Previous runs")).toBeLessThan(output.indexOf("Current prompt"));
    expect(output.indexOf("Current prompt")).toBeLessThan(output.indexOf("Activity"));
    expect(output).toContain("4 turns · 2 tools · 2 compactions · 1ms · 2.5k tokens");
    expect(output.indexOf("Activity")).toBeLessThan(output.indexOf("Final output"));
    expect(output).toContain("Final findings.");
  });

  it("marks the selected conversation across all three row lines", () => {
    const conversations = [
      fakeAgent({ conversationId: "conversation-alpha", label: "alpha", createdAt: 2 }),
      fakeAgent({ conversationId: "conversation-beta", label: "beta", createdAt: 1 }),
    ];
    const { component } = overlay(conversations);

    const initial = component.render(120).join("\n");
    expect(initial).toContain("┃ alpha · helper");
    expect(initial).toContain("┃ completed · 1ms · 0 tokens");
    expect(initial).toContain("┃ finished");
    expect(initial).not.toContain("✓ beta");

    component.handleInput("\x1b[B");
    const moved = component.render(120).join("\n");
    expect(moved).toContain("┃ beta · helper");
    expect(moved).toContain("┃ finished");
    expect(moved).not.toContain("┃ alpha · helper");
  });

  it("renders muted tree rails continuously through separator rows", () => {
    const fg = vi.fn((_color: string, text: string) => text);
    const root = fakeAgent({ conversationId: "root", runId: "root-run" });
    const branchA = fakeAgent({ conversationId: "branch-a", parent: { conversationId: "root", runId: "root-run" } });
    const leafA = fakeAgent({ conversationId: "leaf-a", parent: { conversationId: "branch-a", runId: "r1" } });
    const branchB = fakeAgent({ conversationId: "branch-b", parent: { conversationId: "root", runId: "root-run" } });
    const { component } = overlay([root, branchA, leafA, branchB], {}, { fg });
    const output = component.render(180);
    const branchLine = output.findIndex(line => line.includes("├─ helper"));

    expect(branchLine).toBeGreaterThan(0);
    expect(output[branchLine + 3]).toMatch(/^│   │/);
    expect(fg).toHaveBeenCalledWith("muted", "├─ ");
    expect(fg).toHaveBeenCalledWith("muted", "│  ");
  });

  it("renders timeline metadata, requested config, and colored status", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(120_000);
    const fg = vi.fn((_color: string, text: string) => text);
    const conversation = fakeAgent({
      conversationId: "dappled-maple",
      label: "overlay sample one",
      config: { model: "gpt-5.6-luna", thinking: "low" },
      requestedOverrides: { model: "gpt-5.6-luna", thinking: "low" },
      status: { kind: "completed", startedAt: 1_000, completedAt: 61_000 },
      totalUsage: { ...fakeRunSection().usage, totalTokens: 1_234 },
    });

    try {
      const { component } = overlay([conversation], {}, { fg });
      const output = component.render(200).join("\n");

      expect(output).toContain("overlay sample one · helper (gpt-5.6-luna:low)");
      expect(output).toContain("completed · 1m00s · 1.2k tokens");
      expect(output).toContain("finished 59s ago · 0 turns · 0 tools · dappled-maple");
      expect(fg).toHaveBeenCalledWith("success", "completed");
    } finally {
      now.mockRestore();
    }
  });

  it("omits inherited agent model and thinking from conversation titles", () => {
    const conversation = fakeAgent({
      label: "inherited config",
      config: { model: "agent-default", thinking: "medium" },
    });
    const { component } = overlay([conversation]);

    expect(component.render(160).join("\n")).toContain("inherited config · helper");
    expect(component.render(160).join("\n")).not.toContain("inherited config · helper (");
  });

  it("marks only the selected agent with an accented vertical bar", () => {
    const agents = [
      { name: "alpha", description: "First", source: "project", systemPrompt: "Work." },
      { name: "beta", description: "Second", source: "project", systemPrompt: "Work." },
    ] as any;
    const { component } = overlay([], { initialPage: "agents", agents });

    const initial = component.render(120).join("\n");
    expect(initial).toContain("┃ alpha · project");
    expect(initial).toContain("┃ First");
    expect(initial).toContain("┃ default:default · 0 tools");
    expect(initial).not.toContain("→ alpha · project");
    expect(initial).not.toContain("→ beta · project");

    component.handleInput("\x1b[B");
    const moved = component.render(120).join("\n");
    expect(moved).toContain("┃ beta · project");
    expect(moved).toContain("┃ Second");
    expect(moved).toContain("┃ default:default · 0 tools");
    expect(moved).not.toContain("┃ alpha · project");
    expect(moved).not.toContain("┃ First");
  });

  it("omits the skills count from agent list rows without skills", () => {
    const agent = {
      name: "scout",
      description: "Inspects repositories",
      source: "project",
      tools: ["read", "grep"],
      skills: [],
      systemPrompt: "Inspect the repository.",
    } as any;
    const { component } = overlay([], { initialPage: "agents", agents: [agent] });
    const output = component.render(120).map(line => line.trimEnd()).join("\n");

    expect(output).toContain("default:default · 2 tools");
    expect(output).not.toContain("2 tools · 0 skills");
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
