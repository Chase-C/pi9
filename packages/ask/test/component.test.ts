import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AskComponent } from "../src/component.js";

function theme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function make(options: Partial<ConstructorParameters<typeof AskComponent>[0]> = {}) {
  const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const component = new AskComponent({
    tui: tui as never,
    theme: theme(),
    question: "Which target should receive the release?",
    context: "Both targets currently pass the test suite.",
    options: [
      { label: "Staging", description: "Validate with internal users first" },
      { label: "Production", description: "Release immediately" },
    ],
    allowMultiple: false,
    allowFreeform: true,
    onSubmit,
    onCancel,
    ...options,
  });
  return { component, tui, onSubmit, onCancel };
}

describe("AskComponent", () => {
  it("renders the prompt, descriptions, freeform row, help, and stays within width", () => {
    const { component } = make();
    const lines = component.render(32);

    expect(lines.join("\n")).toContain("Both targets");
    expect(lines.join("\n")).toContain("Which target");
    expect(lines.join("\n")).toContain("Staging");
    expect(lines.join("\n")).toContain("Validate");
    expect(lines.join("\n")).toContain("Type a response");
    expect(lines.join("\n")).toContain("comment");
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  it("uses Enter for single-select and returns the selected option", () => {
    const { component, onSubmit } = make();
    component.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith({
      selections: [{ label: "Staging", description: "Validate with internal users first" }],
    });
    expect(component.answer?.selections[0]?.label).toBe("Staging");
  });

  it("toggles multi-select options with Space and Enter, then submits from the button", () => {
    const { component, onSubmit } = make({ allowMultiple: true });
    expect(component.render(80).join("\n")).toContain("󰄱 Staging");

    component.handleInput(" ");
    expect(component.render(80).join("\n")).toContain("󰄵 Staging");

    component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(onSubmit).not.toHaveBeenCalled();

    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    expect(component.render(80).join("\n")).toContain("› [ Submit ]");
    component.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith({
      selections: [
        { label: "Staging", description: "Validate with internal users first" },
        { label: "Production", description: "Release immediately" },
      ],
    });
  });

  it("opens a comment with literal c without selecting, previews it, and saves with Enter", () => {
    const { component } = make({ allowMultiple: true });
    component.handleInput("c");
    expect(component.state.mode).toBe("comment");
    expect(component.state.checked.size).toBe(0);

    component.handleInput("Safer rollout");
    component.handleInput("\r");
    expect(component.state.mode).toBe("select");
    expect(component.state.comments.get("Staging")).toBe("Safer rollout");
    expect(component.render(80).join("\n")).toContain("✎ Safer rollout");
    expect(component.state.checked.size).toBe(0);
  });

  it("discards comment edits with Escape and cancels from select mode", () => {
    const { component, onCancel } = make();
    component.handleInput("c");
    component.handleInput("discarded");
    component.handleInput("\x1b");
    expect(component.state.mode).toBe("select");
    expect(component.state.comments.size).toBe(0);

    component.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(component.isCancelled).toBe(true);
  });

  it("opens the freeform row by default and submits a single freeform answer", () => {
    const { component, onSubmit } = make({ options: [] });
    component.handleInput("\r");
    expect(component.state.mode).toBe("freeform");

    const lines = component.render(80);
    const optionLine = lines.findIndex(line => line.includes("Type a response"));
    expect(lines[optionLine + 1]).toMatch(/^    ↳ /);
    expect(lines.filter(line => /^─+$/.test(line))).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("Your response");

    component.handleInput("Use the fallback");
    component.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith({ selections: [], freeform: "Use the fallback" });
  });

  it("checks, toggles, and submits a multi-select freeform response", () => {
    const { component, onSubmit } = make({ options: [], allowMultiple: true });
    expect(component.render(80).join("\n")).toContain("󰄱 Type a response");

    component.handleInput("\r");
    const editingLines = component.render(80);
    const freeformRow = editingLines.findIndex(line => line.includes("Type a response"));
    const inputRow = editingLines.findIndex(line => line.includes("↳"));
    const submitRow = editingLines.findIndex(line => line.includes("[ Submit ]"));
    expect(inputRow).toBe(freeformRow + 1);
    expect(submitRow).toBeGreaterThan(inputRow);

    component.handleInput("Use the fallback");
    component.handleInput("\r");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(component.render(80).join("\n")).toContain("󰄵 Type a response… — Use the fallback");

    component.handleInput(" ");
    expect(component.render(80).join("\n")).toContain("󰄱 Type a response… — Use the fallback");
    component.handleInput(" ");
    component.handleInput("\x1b[B");
    component.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith({ selections: [], freeform: "Use the fallback" });
  });

  it("submits an empty freeform-only answer", () => {
    const { component, onSubmit } = make({ options: [] });
    component.handleInput("\r");
    component.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith({ selections: [] });
    expect(component.answer).toEqual({ selections: [] });
  });

  it("propagates focus to Pi Editor for IME cursor placement", () => {
    const { component } = make();
    component.focused = true;
    component.handleInput("c");
    expect(component.focused).toBe(true);
    expect(component.render(80).some((line) => line.includes("\x1b_pi:c\x07"))).toBe(true);

    component.handleInput("\x1b");
    expect(component.render(80).some((line) => line.includes("\x1b_pi:c\x07"))).toBe(false);
  });
});
