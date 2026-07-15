import { describe, expect, it, vi } from "vitest";

const components: Array<{ cancel: ReturnType<typeof vi.fn>; options: any }> = [];
vi.mock("../src/component.js", () => ({
  AskComponent: vi.fn(function (options: any) {
    const component = { cancel: vi.fn(() => options.onCancel()), options };
    components.push(component);
    return component;
  }),
}));

import { launchQuestionnaire } from "../src/questionnaire.js";

const params = {
  question: "Choose",
  context: "Context",
  options: [{ label: "A" }],
  allowMultiple: false,
  allowFreeform: true,
};

function uiHarness(action: "submit" | "cancel" = "submit") {
  const custom = vi.fn(async (factory: any, options: any) => {
    let result: any;
    const component = factory("tui", "theme", "keys", (value: unknown) => { result = value; });
    if (action === "submit") component.options.onSubmit({ selections: [{ label: "A" }] });
    else component.options.onCancel();
    return result;
  });
  return { ui: { custom }, custom };
}

describe("launchQuestionnaire", () => {
  it("launches a fresh custom component and returns its answer", async () => {
    const first = uiHarness();
    const second = uiHarness();
    await expect(launchQuestionnaire({ ui: first.ui }, params)).resolves.toEqual({ selections: [{ label: "A" }] });
    await launchQuestionnaire({ ui: second.ui }, params);

    expect(components.at(-2)).not.toBe(components.at(-1));
    expect(components.at(-1)?.options).toMatchObject({ tui: "tui", theme: "theme", keybindings: "keys", ...params });
    expect(second.custom).toHaveBeenCalledWith(expect.any(Function));
  });

  it("returns null when the component cancels", async () => {
    const { ui } = uiHarness("cancel");
    await expect(launchQuestionnaire({ ui }, params)).resolves.toBeNull();
  });

  it("normalizes an unexpected undefined custom result to null", async () => {
    const custom = vi.fn().mockResolvedValue(undefined);
    await expect(launchQuestionnaire({ ui: { custom } }, params)).resolves.toBeNull();
  });

  it.each(["success", "cancel", "error"])("removes its abort listener after %s", async outcome => {
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    const harness = uiHarness(outcome === "cancel" ? "cancel" : "submit");
    if (outcome === "error") harness.ui.custom = vi.fn(async (factory: any) => {
      factory("tui", "theme", "keys", vi.fn());
      throw new Error("UI failed");
    });

    const result = launchQuestionnaire({ ui: harness.ui }, params, signal);
    if (outcome === "error") await expect(result).rejects.toThrow("UI failed");
    else await result;

    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  });

  it("cancels the active component when aborted", async () => {
    const controller = new AbortController();
    const custom = vi.fn((factory: any) => new Promise<any>(resolve => {
      factory("tui", "theme", "keys", resolve);
    }));
    const result = launchQuestionnaire({ ui: { custom } }, params, controller.signal);
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(components.at(-1)?.cancel).toHaveBeenCalledOnce();
  });
});
