import { expect, test, vi } from "vitest";
import { SubagentOverlayComponent } from "../../src/command/overlay.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";
import { fakeAgent, fakeGeneration } from "../helpers/fake-agent.js";

function overlayFixture(initial = fakeAgent(), others: ReturnType<typeof fakeAgent>[] = []) {
  let conversation = {
    ...initial,
    resumeAllowed: initial.resumeAllowed ?? initial.generations.at(-1)?.joined === true,
  };
  let listener = () => {};
  const notify = vi.fn();
  const onCollect = vi.fn(async () => {
    const latest = conversation.generations.at(-1)!;
    conversation = {
      ...conversation,
      resumeAllowed: true,
      generations: [...conversation.generations.slice(0, -1), { ...latest, joined: true }],
    };
    listener();
  });
  const onResume = vi.fn();
  const manager = {
    listConversations: () => [conversation, ...others],
    onConversationUpdate: (next: () => void) => { listener = next; return () => {}; },
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender: vi.fn() },
    {} as any,
    {} as any,
    vi.fn(),
    {
      initialPage: "conversations",
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      notify,
      onSettingsChange: vi.fn(),
      onStart: vi.fn(),
      onResume,
      onCollect,
    },
  );
  return { component, notify, onCollect, onResume };
}

test("completed results must be collected before the overlay enables resume", async () => {
  const { component, onCollect, onResume } = overlayFixture();

  expect(component.render(100).join("\n")).toContain("enter inspect · g collect · x remove");
  expect(component.render(100).join("\n")).not.toContain("enter inspect · r resume · x remove");

  component.handleInput("g");
  await vi.waitFor(() => expect(onCollect).toHaveBeenCalledWith("c1"));

  expect(component.render(100).join("\n")).not.toContain("enter inspect · g collect · x remove");
  expect(component.render(100).join("\n")).toContain("enter inspect · r resume · x remove");
  component.handleInput("r");
  (component as any).submitPrompt("follow up");
  expect(onResume).toHaveBeenCalledWith("c1", "follow up");
});

test("the overlay trusts the snapshot resume capability", () => {
  const { component, onResume } = overlayFixture(fakeAgent({ joined: true, resumeAllowed: false }));

  expect(component.render(100).join("\n")).not.toContain("enter inspect · r resume · x remove");
  component.handleInput("r");
  expect(onResume).not.toHaveBeenCalled();
});

test("the overlay does not collect active or already joined results", async () => {
  for (const conversation of [
    fakeAgent({ status: { kind: "running" } }),
    fakeAgent({ joined: true, resumeAllowed: true }),
  ]) {
    const { component, onCollect } = overlayFixture(conversation);
    component.handleInput("g");
    await Promise.resolve();
    expect(onCollect).not.toHaveBeenCalled();
  }
});

test("collection failures remain unjoined and are reported", async () => {
  const fixture = overlayFixture();
  fixture.onCollect.mockRejectedValueOnce(new Error("collect failed"));

  fixture.component.handleInput("g");
  await vi.waitFor(() => expect(fixture.notify).toHaveBeenCalledWith("collect failed", "warning"));

  expect(fixture.component.render(100).join("\n")).toContain("enter inspect · g collect · x remove");
  expect(fixture.component.render(100).join("\n")).not.toContain("enter inspect · r resume · x remove");
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
