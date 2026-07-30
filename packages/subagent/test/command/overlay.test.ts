import { expect, test, vi } from "vitest";
import { SubagentOverlayComponent } from "../../src/command/overlay.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";
import { fakeAgent } from "../helpers/fake-agent.js";

function overlayFixture(initial = fakeAgent()) {
  let conversation = initial;
  let listener = () => {};
  const notify = vi.fn();
  const onCollect = vi.fn(async () => {
    const latest = conversation.runs.at(-1)!;
    conversation = { ...conversation, runs: [...conversation.runs.slice(0, -1), { ...latest, joined: true }] };
    listener();
  });
  const onResume = vi.fn();
  const manager = {
    listConversations: () => [conversation],
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

test("the overlay does not collect active or already joined results", async () => {
  for (const conversation of [
    fakeAgent({ status: { kind: "running" } }),
    fakeAgent({ resumable: true }),
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
