import { expect, test, vi } from "vitest";
import { SubagentOverlayComponent } from "../../src/command/overlay.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";
import { fakeAgent, fakeGeneration } from "../helpers/fake-agent.js";

function overlayFixture(
  initial = fakeAgent({ initiatedBy: "user" }),
  others: ReturnType<typeof fakeAgent>[] = [],
  initialPage: "conversations" | "agents" | "settings" = "conversations",
) {
  let conversations = [initial, ...others];
  let listener = () => {};
  const notify = vi.fn();
  const collectSubagentForUser = vi.fn((conversationId: string) => {
    const index = conversations.findIndex(conversation => conversation.conversationId === conversationId);
    const conversation = conversations[index];
    const latest = conversation?.generations.at(-1);
    const collected = Boolean(conversation && !conversation.parentConversationId && latest?.status.kind === "done");
    if (conversation && latest && collected && !latest.receipts.user) {
      const generation = { ...latest, receipts: { ...latest.receipts, user: true } };
      conversations[index] = {
        ...conversation,
        generations: [...conversation.generations.slice(0, -1), generation],
        resumeAllowed: generation.initiatedBy === "user" || conversation.resumeAllowed,
      };
      listener();
    }
    return { conversationId, generation: latest?.generation ?? 0, collected };
  });
  const onResume = vi.fn();
  const manager = {
    listConversations: () => conversations,
    onConversationUpdate: (next: () => void) => { listener = next; return () => {}; },
    collectSubagentForUser,
    projectSubagent: (conversationId: string) => ({
      actionHints: conversations.find(conversation => conversation.conversationId === conversationId)?.currentGeneration ? [] : ["remove"],
    }),
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender: vi.fn() },
    {} as any,
    {} as any,
    vi.fn(),
    {
      initialPage,
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      notify,
      onSettingsChange: vi.fn(),
      onStart: vi.fn(),
      onResume,
    },
  );
  return {
    component,
    notify,
    collectSubagentForUser,
    onResume,
    conversation: (conversationId: string) => conversations.find(conversation => conversation.conversationId === conversationId)!,
    updateConversation: (next: ReturnType<typeof fakeAgent>) => {
      conversations = conversations.map(conversation => conversation.conversationId === next.conversationId ? next : conversation);
      listener();
    },
  };
}

test("initial terminal selection is automatically collected and immediately enables snapshot actions", () => {
  const fixture = overlayFixture();

  expect(fixture.collectSubagentForUser).toHaveBeenCalledOnce();
  expect(fixture.collectSubagentForUser).toHaveBeenCalledWith("c1");
  expect(fixture.conversation("c1").generations.at(-1)).toMatchObject({
    activeCollectionCount: 0,
    receipts: { user: true, model: false },
  });
  const rendered = fixture.component.render(100).join("\n");
  expect(rendered).not.toContain("collect");
  expect(rendered).not.toContain("[g]");
  expect(rendered).toContain("[r] resume");

  fixture.component.handleInput("g");
  expect(fixture.collectSubagentForUser).toHaveBeenCalledOnce();
});

test("navigation automatically collects only each newly selected terminal conversation", () => {
  const first = fakeAgent({ conversationId: "first", label: "First", initiatedBy: "user", createdAt: 2 });
  const second = fakeAgent({ conversationId: "second", label: "Second", initiatedBy: "user", createdAt: 1 });
  const fixture = overlayFixture(first, [second]);

  expect(fixture.collectSubagentForUser.mock.calls).toEqual([["first"]]);
  expect(fixture.conversation("second").generations.at(-1)?.receipts.user).toBe(false);

  fixture.component.handleInput("j");

  expect(fixture.collectSubagentForUser.mock.calls).toEqual([["first"], ["second"]]);
  expect(fixture.conversation("second").generations.at(-1)).toMatchObject({
    activeCollectionCount: 0,
    receipts: { user: true, model: false },
  });
});

test("filter selection changes and returning to conversations trigger automatic collection", () => {
  const first = fakeAgent({ conversationId: "first", label: "Alpha", initiatedBy: "user", createdAt: 2 });
  const second = fakeAgent({ conversationId: "second", label: "Beta", initiatedBy: "user", createdAt: 1 });
  const filtered = overlayFixture(first, [second]);
  filtered.component.handleInput("/");
  filtered.component.handleInput("B");
  expect(filtered.collectSubagentForUser.mock.calls).toEqual([["first"], ["second"]]);

  const returning = overlayFixture(first, [], "agents");
  expect(returning.collectSubagentForUser).not.toHaveBeenCalled();
  returning.component.handleInput("\t");
  expect(returning.collectSubagentForUser).toHaveBeenCalledWith("first");
});

test("a selected active generation is collected when a runtime update makes it terminal", () => {
  const running = fakeAgent({ initiatedBy: "user", status: { kind: "running" } });
  const fixture = overlayFixture(running);
  expect(fixture.collectSubagentForUser.mock.calls).toEqual([["c1"]]);

  fixture.updateConversation(fakeAgent({ initiatedBy: "user", status: { kind: "completed" } }));

  expect(fixture.collectSubagentForUser.mock.calls).toEqual([["c1"], ["c1"]]);
  expect(fixture.conversation("c1").generations.at(-1)).toMatchObject({
    activeCollectionCount: 0,
    receipts: { user: true, model: false },
  });
});

test("a newly resumed generation can be collected after the previous generation attempt", () => {
  const first = fakeGeneration({ generation: 1, initiatedBy: "user", receipts: { user: true } });
  const running = fakeGeneration({ generation: 2, initiatedBy: "user", status: { kind: "running" } });
  const fixture = overlayFixture(fakeAgent({ generations: [first], resumeAllowed: true }));

  fixture.updateConversation(fakeAgent({ generations: [first, running] }));
  const completed = fakeGeneration({ generation: 2, initiatedBy: "user", status: { kind: "completed" } });
  fixture.updateConversation(fakeAgent({ generations: [first, completed] }));

  expect(fixture.collectSubagentForUser.mock.calls).toEqual([["c1"], ["c1"], ["c1"]]);
  expect(fixture.conversation("c1").generations.at(-1)?.receipts.user).toBe(true);
});

test("an inactive unselected completion is not collected", () => {
  const selected = fakeAgent({ conversationId: "selected", status: { kind: "running" }, createdAt: 2 });
  const inactive = fakeAgent({ conversationId: "inactive", status: { kind: "running" }, createdAt: 1 });
  const fixture = overlayFixture(selected, [inactive]);

  fixture.updateConversation(fakeAgent({ conversationId: "inactive", status: { kind: "completed" }, createdAt: 1 }));

  expect(fixture.collectSubagentForUser.mock.calls).toEqual([["selected"]]);
  expect(fixture.conversation("inactive").generations.at(-1)).toMatchObject({
    activeCollectionCount: 0,
    receipts: { user: false, model: false },
  });
});

test("already collected selection is harmless and does not create active collection state", () => {
  const fixture = overlayFixture(fakeAgent({ initiatedBy: "user", receipts: { user: true }, resumeAllowed: true }));

  expect(fixture.collectSubagentForUser.mock.calls).toEqual([["c1"]]);
  expect(fixture.conversation("c1").generations.at(-1)).toMatchObject({
    activeCollectionCount: 0,
    receipts: { user: true, model: false },
  });
  fixture.component.render(100);
  fixture.component.render(100);
  expect(fixture.collectSubagentForUser).toHaveBeenCalledOnce();
});

test("the overlay trusts the snapshot resume capability", () => {
  const { component, onResume } = overlayFixture(fakeAgent({ receipts: { user: true }, resumeAllowed: false }));

  expect(component.render(100).join("\n")).not.toContain("enter inspect · r resume · x remove");
  component.handleInput("r");
  expect(onResume).not.toHaveBeenCalled();
});

test("generation detail uses one-based chronology instead of opaque identities", () => {
  const first = fakeGeneration({ generation: 1, prompt: "first task" });
  const second = fakeGeneration({ generation: 2, prompt: "follow-up task" });
  const { component } = overlayFixture(fakeAgent({ generations: [first, second] }));

  component.handleInput("\r");
  const rendered = component.render(120).join("\n");

  expect(rendered).toContain("generation 2");
  expect(rendered).toContain("Previous generations");
  expect(rendered).toContain("generation #1");
});

test("nested chronology scopes generation numbers to their parent conversation", () => {
  const root = fakeAgent({ conversationId: "root", label: "Root" });
  const child = fakeAgent({ conversationId: "child", parentConversationId: "root", spawnedInGeneration: 1, label: "Right child" });
  const grandchild = fakeAgent({ conversationId: "grandchild", parentConversationId: "child", spawnedInGeneration: 1, label: "Grandchild" });
  const unrelated = fakeAgent({ conversationId: "unrelated", parentConversationId: "another-parent", spawnedInGeneration: 1, label: "Wrong child" });
  const { component } = overlayFixture(root, [child, grandchild, unrelated]);

  const rendered = component.render(120).join("\n");

  expect(rendered).toContain("Right child");
  expect(rendered).toContain("Grandchild");
  expect(rendered).not.toContain("Wrong child");
});

test("conversation browser always renders as a tree", () => {
  const root = fakeAgent({ conversationId: "root", label: "Root" });
  const child = fakeAgent({ conversationId: "child", parentConversationId: "root", label: "Child" });
  const { component } = overlayFixture(root, [child]);

  const initial = component.render(120).join("\n");
  expect(initial).toContain("╰─ Child");
  expect(initial).not.toMatch(/View:|flat\/tree/);

  component.handleInput("t");
  expect(component.render(120).join("\n")).toContain("╰─ Child");
});

test.each([
  ["agents", "↑↓ select · PgUp/PgDn scroll details · / filter · tab pages · esc close"],
  ["conversations", "↑↓ select · PgUp/PgDn scroll details · / filter · tab pages · esc close"],
  ["settings", "↑↓ select · enter/space change · tab pages · esc close"],
] as const)("%s navigation help is muted", (initialPage, navigation) => {
  const fg = vi.fn((_color: string, text: string) => text);
  const component = new SubagentOverlayComponent(
    { listConversations: () => [], onConversationUpdate: () => () => {} } as any,
    { requestRender: vi.fn() },
    { fg, bold: (text: string) => text } as any,
    {} as any,
    vi.fn(),
    {
      initialPage,
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      notify: vi.fn(),
      onSettingsChange: vi.fn(),
      onStart: vi.fn(),
      onResume: vi.fn(),
    },
  );

  component.render(120);
  expect(fg).toHaveBeenCalledWith("muted", navigation);
  expect(fg).not.toHaveBeenCalledWith("dim", navigation);
});

test("browser help aligns its divider and emphasizes agent actions", () => {
  const fg = vi.fn((_color: string, text: string) => text);
  const component = new SubagentOverlayComponent(
    { listConversations: () => [], onConversationUpdate: () => () => {} } as any,
    { requestRender: vi.fn() },
    { fg, bold: (text: string) => text } as any,
    {} as any,
    vi.fn(),
    {
      initialPage: "agents",
      agents: [{ name: "helper", description: "Reviews code", systemPrompt: "Review carefully", source: "project" }],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      notify: vi.fn(),
      onSettingsChange: vi.fn(),
      onStart: vi.fn(),
      onResume: vi.fn(),
    },
  );

  const lines = component.render(100);
  const browserLine = lines.find(line => line.includes("helper · project"))!;
  const helpLine = lines.find(line => line.includes("[enter/s] delegate to helper"))!;
  const internalDivider = (line: string) => [...line.matchAll(/│/g)][1]!.index;

  const divider = internalDivider(helpLine);
  expect(divider).toBe(internalDivider(browserLine));
  expect(helpLine.slice(0, divider)).toContain("↑↓ select");
  expect(helpLine.slice(0, divider)).not.toContain("[enter/s]");
  expect(helpLine.slice(divider + 1)).toContain("[enter/s] delegate to helper");
  expect(lines.join("\n")).not.toContain("Start helper");
  expect(fg).toHaveBeenCalledWith("warning", "[enter/s]");
  expect(fg).toHaveBeenCalledWith("accent", "delegate to helper");

  component.handleInput("\r");
  const composing = component.render(100).join("\n");
  expect(composing).toContain("Task prompt");
  expect(composing).not.toContain("Start helper");
});

test("empty narrow browsers do not reserve a blank action row", () => {
  const component = new SubagentOverlayComponent(
    { listConversations: () => [], onConversationUpdate: () => () => {} } as any,
    { requestRender: vi.fn() },
    {} as any,
    {} as any,
    vi.fn(),
    {
      initialPage: "agents",
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      notify: vi.fn(),
      onSettingsChange: vi.fn(),
      onStart: vi.fn(),
      onResume: vi.fn(),
    },
  );

  expect(component.render(70).at(-2)).toContain("close");
});

test("conversation actions render as colored chips separate from navigation", () => {
  const fg = vi.fn((_color: string, text: string) => text);
  const conversation = fakeAgent({ status: { kind: "running" } });
  const component = new SubagentOverlayComponent(
    { listConversations: () => [conversation], onConversationUpdate: () => () => {}, collectSubagentForUser: vi.fn() } as any,
    { requestRender: vi.fn() },
    { fg, bold: (text: string) => text } as any,
    {} as any,
    vi.fn(),
    {
      initialPage: "conversations",
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      notify: vi.fn(),
      onSettingsChange: vi.fn(),
      onStart: vi.fn(),
      onResume: vi.fn(),
    },
  );

  const lines = component.render(120);
  const actionText = lines.filter(line => /\[(enter|c|g|r|x)\]/.test(line)).join("\n");
  const helpLine = lines.find(line => line.includes("↑↓ select"))!;
  const divider = [...helpLine.matchAll(/│/g)][1]!.index;

  expect(lines).toHaveLength(30);
  expect(actionText).toContain("[enter] inspect");
  expect(actionText).toContain("[c] cancel");
  expect(actionText).not.toContain("[g] collect");
  expect(actionText).not.toContain("[r] resume");
  expect(actionText).not.toContain("[x] remove");
  expect(helpLine.slice(0, divider)).not.toMatch(/\[(enter|c|g|r|x)\]/);
  expect(helpLine.slice(divider + 1)).toContain("[enter] inspect");
  expect(actionText.match(/\[enter\] inspect/g)).toHaveLength(1);
  expect(actionText.match(/\[c\] cancel/g)).toHaveLength(1);
  expect(fg).toHaveBeenCalledWith("warning", "[c]");
  expect(fg).toHaveBeenCalledWith("accent", "cancel");

  component.handleInput("\r");
  const detail = component.render(120).join("\n");
  expect(detail).not.toContain("[enter] inspect");
  expect(detail.match(/\[c\] cancel/g)).toHaveLength(1);
});

test("conversation actions hide unavailable subtree mutations", () => {
  const root = fakeAgent({ conversationId: "root", receipts: { model: true }, resumeAllowed: true, createdAt: 2 });
  const child = fakeAgent({
    conversationId: "child",
    parentConversationId: "root",
    spawnedInGeneration: 1,
    status: { kind: "running" },
    createdAt: 1,
  });
  const onCancel = vi.fn();
  const onRemove = vi.fn();
  const component = new SubagentOverlayComponent(
    { listConversations: () => [root, child], onConversationUpdate: () => () => {}, collectSubagentForUser: vi.fn() } as any,
    { requestRender: vi.fn() },
    {} as any,
    {} as any,
    vi.fn(),
    {
      initialPage: "conversations",
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      notify: vi.fn(),
      onSettingsChange: vi.fn(),
      onStart: vi.fn(),
      onResume: vi.fn(),
      onCancel,
      onRemove,
    },
  );

  const rootHelp = component.render(120).filter(line => /\[(enter|c|g|r|x)\]/.test(line)).join("\n");
  expect(rootHelp).toContain("[enter] inspect");
  expect(rootHelp).toContain("[r] resume");
  expect(rootHelp).not.toContain("[c] cancel");
  expect(rootHelp).not.toContain("[x] remove");
  component.handleInput("c");
  component.handleInput("x");
  expect(onCancel).not.toHaveBeenCalled();
  expect(onRemove).not.toHaveBeenCalled();

  component.handleInput("j");
  const childHelp = component.render(120).filter(line => /\[(enter|c|g|r|x)\]/.test(line)).join("\n");
  expect(childHelp).toContain("[enter] inspect");
  expect(childHelp).not.toMatch(/\[(c|g|r|x)\]/);
  component.handleInput("c");
  component.handleInput("x");
  expect(onCancel).not.toHaveBeenCalled();
  expect(onRemove).not.toHaveBeenCalled();
});

test("agent details scroll instead of truncating long descriptions", () => {
  const description = `description-start ${Array(80).fill("detail").join(" ")} description-end`;
  const component = new SubagentOverlayComponent(
    { listConversations: () => [], onConversationUpdate: () => () => {} } as any,
    { requestRender: vi.fn(), terminal: { rows: 20 } } as any,
    {} as any,
    {} as any,
    vi.fn(),
    {
      initialPage: "agents",
      agents: [{ name: "helper", description, systemPrompt: "instructions", source: "project" }],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      notify: vi.fn(),
      onSettingsChange: vi.fn(),
      onStart: vi.fn(),
      onResume: vi.fn(),
    },
  );

  const initial = component.render(100).join("\n");
  expect(initial).toContain("description-start");
  expect(initial).not.toContain("description-end");
  expect(initial).toContain("▼");
  expect(initial).not.toContain("▲");

  component.handleInput("\x1b[6~");
  const middle = component.render(100).join("\n");
  expect(middle).toContain("description-end");
  expect(middle).toContain("▲");
  expect(middle.split("\n")[3]).toContain("▲");
  expect(middle).toContain("▼");

  for (let index = 0; index < 10; index++) component.handleInput("\x1b[6~");
  const bottom = component.render(100).join("\n");
  expect(bottom).toContain("▲");
  expect(bottom).not.toContain("▼");

  for (let index = 0; index < 10; index++) component.handleInput("\x1b[5~");
  expect(component.render(100).join("\n")).toContain("description-start");
});

test("conversation details scroll instead of collapsing the middle", () => {
  const prompt = `prompt-start ${Array(300).fill("context").join(" ")} prompt-end`;
  const conversation = fakeAgent({ generations: [fakeGeneration({ prompt })] });
  const { component } = overlayFixture(conversation);

  const initial = component.render(100).join("\n");
  expect(initial).toContain("prompt-start");
  expect(initial).not.toContain("prompt-end");
  expect(initial).toContain("▼");

  for (let index = 0; index < 10; index++) component.handleInput("\x1b[6~");
  const scrolled = component.render(100).join("\n");
  expect(scrolled).toContain("prompt-end");
  expect(scrolled).toContain("▲");
  expect(scrolled).not.toContain("▼");
});

test("nested chronology renders the exact child generation and recurses from it", () => {
  const root = fakeAgent({
    conversationId: "root",
    label: "Root",
    generations: [fakeGeneration({ generation: 1 }), fakeGeneration({ generation: 2 })],
  });
  const child = fakeAgent({
    conversationId: "child",
    parentConversationId: "root",
    spawnedInGeneration: 1,
    label: "Resumed child",
    generations: [
      fakeGeneration({ generation: 1, startedInParentGeneration: 1, status: { kind: "completed" } }),
      fakeGeneration({ generation: 2, startedInParentGeneration: 2, status: { kind: "running" } }),
    ],
  });
  const grandchild = fakeAgent({
    conversationId: "grandchild",
    parentConversationId: "child",
    spawnedInGeneration: 2,
    startedInParentGeneration: 2,
    label: "Generation two descendant",
  });
  const { component } = overlayFixture(root, [child, grandchild]);

  component.handleInput("\r");
  const rendered = component.render(120).join("\n");

  expect(rendered).toContain("Resumed child · helper · running");
  expect(rendered).toContain("Generation two descendant");
  expect(rendered).not.toContain("Resumed child · helper · completed");
});
