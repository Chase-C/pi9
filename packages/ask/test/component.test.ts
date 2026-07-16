import { describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
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
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS, {}),
    onSubmit,
    onCancel,
    ...options,
  });
  return { component, tui, onSubmit, onCancel };
}

describe("AskComponent", () => {
  initTheme("dark", false);

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
    expect(component.render(80).join("\n")).not.toContain("Staging [selected]");

    component.handleInput(" ");
    expect(component.render(80).join("\n")).toContain("Staging [selected]");

    component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(onSubmit).not.toHaveBeenCalled();

    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    expect(component.render(80).join("\n")).toContain("┃ [ Submit ]");
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
    expect(component.state.editor.kind).toBe("comment");
    expect(component.state.checked.size).toBe(0);

    component.handleInput("Safer rollout");
    component.handleInput("\r");
    expect(component.state.editor.kind).toBe("select");
    expect(component.state.comments.get("Staging")).toBe("Safer rollout");
    expect(component.render(80).join("\n")).toContain("✎ Safer rollout");
    expect(component.state.checked.size).toBe(0);
  });

  it("renders the comment editor directly below its target option", () => {
    const { component } = make();
    component.handleInput("c");

    const lines = component.render(80);
    const optionIndex = lines.findIndex(line => line.includes("Staging"));
    const editorIndex = lines.findIndex(line => line.includes("↳"));
    const freeformIndex = lines.findIndex(line => line.includes("Type a response"));

    expect(optionIndex).toBeGreaterThan(-1);
    expect(editorIndex).toBeGreaterThan(optionIndex);
    expect(editorIndex).toBeLessThan(freeformIndex);
  });

  it("discards comment edits with Escape and cancels from select mode", () => {
    const { component, onCancel } = make();
    component.handleInput("c");
    component.handleInput("discarded");
    component.handleInput("\x1b");
    expect(component.state.editor.kind).toBe("select");
    expect(component.state.comments.size).toBe(0);

    component.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(component.isCancelled).toBe(true);
  });

  it("opens a valid freeform row and submits a single freeform answer", () => {
    const { component, onSubmit } = make({ options: [{ label: "Use default" }] });
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(component.state.editor.kind).toBe("freeform");

    const lines = component.render(80);
    const freeformRow = lines.findIndex(line => line.includes("Type a response"));
    expect(lines[freeformRow + 1]).toMatch(/^    ↳ /);
    expect(lines.filter(line => /^─+$/.test(line))).toHaveLength(2);

    component.handleInput("Use the fallback");
    component.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledWith({ selections: [], freeform: "Use the fallback" });
  });

  it("checks, toggles, and submits a valid multi-select freeform response", () => {
    const { component, onSubmit } = make({
      options: [{ label: "Use default" }],
      allowMultiple: true,
    });
    component.handleInput("\x1b[B");
    expect(component.render(80).join("\n")).not.toContain("Type a response… [selected]");

    component.handleInput("\r");
    component.handleInput("Use the fallback");
    component.handleInput("\r");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(component.render(80).join("\n")).toContain("Type a response… — Use the fallback [selected]");

    component.handleInput(" ");
    expect(component.render(80).join("\n")).not.toContain("Type a response… — Use the fallback [selected]");
    component.handleInput(" ");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledWith({ selections: [], freeform: "Use the fallback" });
  });

  it("keeps a blank single-select freeform response open", () => {
    const { component, onSubmit } = make({ options: [{ label: "Use default" }] });
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    component.handleInput("\r");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(component.answer).toBeNull();
    expect(component.state.editor.kind).toBe("select");
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

  it("fits a small terminal while keeping the focused wrapped option visible", () => {
    const tui = { terminal: { rows: 6 }, requestRender: vi.fn() };
    const { component } = make({
      tui: tui as never,
      context: "A context that can scroll away",
      options: [
        { label: "First", description: "A short description" },
        { label: "Second", description: "A short description" },
        { label: "Third", description: "A short description" },
      ],
    });

    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    const lines = component.render(24);

    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(lines.join("\n")).toContain("Third");
  });

  it("hangs wrapped option labels under their first-line text", () => {
    const { component } = make({
      options: [{ label: "A very long option label that must wrap" }],
      allowMultiple: true,
      allowFreeform: false,
    });

    const lines = component.render(20);
    const firstLine = lines.findIndex(line => line.includes("A very long"));
    const textIndex = lines[firstLine].indexOf("A very long");
    const textColumn = visibleWidth(lines[firstLine].slice(0, textIndex));

    expect(firstLine).toBeGreaterThan(-1);
    expect(lines[firstLine + 1]).toMatch(new RegExp(`^ {${textColumn}}\\S`));
  });

  it("keeps a selected submit row visible in a small terminal", () => {
    const tui = { terminal: { rows: 6 }, requestRender: vi.fn() };
    const { component } = make({
      tui: tui as never,
      allowMultiple: true,
      options: [
        { label: "First", description: "A short description" },
        { label: "Second", description: "A short description" },
      ],
    });

    component.handleInput("\x1b[H");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    const lines = component.render(24);

    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.join("\n")).toContain("[ Submit ]");
  });

  it("keeps the active editor cursor and latest line visible in a short terminal", () => {
    const tui = { terminal: { rows: 7 }, requestRender: vi.fn() };
    const { component } = make({ tui: tui as never, options: [{ label: "Only", description: "A description" }] });
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    component.focused = true;
    component.handleInput("first line");
    component.handleInput("\n");
    component.handleInput("second line");
    component.handleInput("\n");
    component.handleInput("third line");
    component.handleInput("\n");
    component.handleInput("latest line");

    const lines = component.render(30);
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
    expect(lines.join("\n")).toContain("latest line");
    expect(lines.some((line) => line.includes("latest line") && line.includes(CURSOR_MARKER))).toBe(true);
  });

  it("preserves a full-width cursor row when the short viewport adds an overflow marker", () => {
    const tui = { terminal: { rows: 4 }, requestRender: vi.fn() };
    const { component } = make({ tui: tui as never, options: [{ label: "Only" }] });
    component.handleInput("\x1b[B");
    const value = "x".repeat(23);
    component.handleInput("\r");
    component.focused = true;
    component.handleInput(value);

    const lines = component.render(30);
    const cursorLine = lines.find(line => line.includes(CURSOR_MARKER));
    expect(lines).toHaveLength(4);
    expect(lines.every(line => visibleWidth(line) <= 30)).toBe(true);
    expect(cursorLine).toBeDefined();
    expect(cursorLine).toContain(value[value.length - 1]);
  });

  it("renders a highlighted option preview as themed markdown in a wide split", () => {
    const { component } = make({
      options: [{
        label: "Staging",
        description: "Validate with internal users first",
        preview: "# Staging\n\n```toml\n[release]\ntarget = \"staging\"\n```\n\nASCII: +--+ | ok | +--+",
      }],
      allowFreeform: false,
    });

    const lines = component.render(100);
    const output = lines.join("\n");
    expect(output).toContain("[release]");
    expect(output).toContain("target");
    expect(output).toContain("ASCII: +--+");
    const header = lines.find(line => line.includes("PREVIEW · FOCUSED OPTION"));
    expect(header).toMatch(/^│ {2}OPTIONS/);
    expect(header).toContain("│ PREVIEW · FOCUSED OPTION");
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    expect(lines.some(line => line.includes("┃ Staging") && line.includes("│"))).toBe(true);
    expect(lines.every(line => visibleWidth(line) <= 100)).toBe(true);
  });

  it("does not treat literal pane glyphs in prompt text as wide-layout structure", () => {
    const { component } = make({
      question: "Choose carefully │ this is part of the question",
      context: "Deployment context │ keep this literal suffix",
      options: [{ label: "Staging", preview: "PREVIEW_CONTENT" }],
      allowFreeform: false,
    });

    const lines = component.render(100);
    const output = lines.join("\n");
    expect(output).toContain("Choose carefully │ this is part of the question");
    expect(output).toContain("Deployment context │ keep this literal suffix");
    expect(output.match(/PREVIEW_CONTENT/g)).toHaveLength(1);
    expect(lines.find(line => line.includes("PREVIEW_CONTENT"))).toContain("│ PREVIEW_CONTENT");
  });

  it("starts a wide preview at the top of its pane regardless of the highlighted option", () => {
    const { component } = make({
      options: [
        { label: "First" },
        { label: "Second", preview: "TOP_ALIGNED_PREVIEW" },
      ],
      allowFreeform: false,
    });

    component.handleInput("\x1b[B");
    const lines = component.render(100);

    const headerIndex = lines.findIndex(line => line.includes("PREVIEW · FOCUSED OPTION"));
    const previewIndex = lines.findIndex(line => line.includes("TOP_ALIGNED_PREVIEW"));
    expect(headerIndex).toBeGreaterThan(-1);
    expect(previewIndex).toBeGreaterThan(headerIndex);
  });

  it.each([80, 100])("keeps the dialog height stable between differently sized previews at width %i", (width) => {
    const { component } = make({
      options: [
        { label: "Short", preview: "Short preview" },
        { label: "Long", preview: "# Long preview\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph." },
      ],
      allowFreeform: false,
    });

    const shortHeight = component.render(width).length;
    component.handleInput("\x1b[B");
    const longLines = component.render(width);

    expect(longLines.join("\n")).toContain("Third paragraph.");
    expect(longLines).toHaveLength(shortHeight);
  });

  it("stacks a preview on narrow terminals and removes it for non-preview rows", () => {
    const { component } = make({
      options: [
        { label: "Staging", preview: "NARROW_PREVIEW_SENTINEL" },
        { label: "Production" },
      ],
      allowFreeform: false,
    });

    const withPreview = component.render(80);
    expect(withPreview.join("\n")).toContain("NARROW_PREVIEW_SENTINEL");
    expect(withPreview.some(line => line.includes("│"))).toBe(false);
    component.handleInput("\x1b[B");
    const withoutPreview = component.render(80).join("\n");
    expect(withoutPreview).not.toContain("NARROW_PREVIEW_SENTINEL");
    expect(withoutPreview).not.toContain("│");
  });

  it.each([80, 100])("keeps the preview region height on freeform and submit rows at width %i", (width) => {
    const { component } = make({
      options: [{ label: "Staging", preview: "MULTI_PREVIEW_SENTINEL" }],
      allowMultiple: true,
      allowFreeform: true,
    });

    const optionLines = component.render(width);
    expect(optionLines.join("\n")).toContain("MULTI_PREVIEW_SENTINEL");

    component.handleInput("\x1b[B");
    const freeformLines = component.render(width);
    expect(freeformLines.join("\n")).not.toContain("MULTI_PREVIEW_SENTINEL");
    expect(freeformLines).toHaveLength(optionLines.length);

    component.handleInput("\x1b[B");
    const submitLines = component.render(width);
    expect(submitLines.join("\n")).not.toContain("MULTI_PREVIEW_SENTINEL");
    expect(submitLines).toHaveLength(optionLines.length);
    expect(submitLines.some(line => line.includes("│"))).toBe(width >= 88);
  });

  it("keeps wide column headers visible while editing a freeform response", () => {
    const { component } = make({
      options: [{ label: "Staging", preview: "PREVIEW_SENTINEL" }],
      allowFreeform: true,
    });

    component.handleInput("\x1b[B");
    component.handleInput("\r");
    const output = component.render(100).join("\n");

    expect(component.state.editor.kind).toBe("freeform");
    expect(output).toContain("OPTIONS");
    expect(output).toContain("PREVIEW · FOCUSED OPTION");
    expect(output).toContain("Type a response");
  });

  it("keeps the selected option and fixed chrome visible while clipping long previews", () => {
    const tui = { terminal: { rows: 8 }, requestRender: vi.fn() };
    const { component } = make({
      tui: tui as never,
      options: [{ label: "Only", preview: Array.from({ length: 80 }, (_, i) => `preview-${i}`).join("\n") }],
      allowFreeform: false,
    });

    const lines = component.render(100);
    expect(lines).toHaveLength(8);
    expect(lines.join("\n")).toContain("Only");
    expect(lines.every(line => visibleWidth(line) <= 100)).toBe(true);
  });

  it("keeps a low focused stacked preview visible in a short narrow viewport", () => {
    const tui = { terminal: { rows: 5 }, requestRender: vi.fn() };
    const { component } = make({
      tui: tui as never,
      allowFreeform: false,
      options: Array.from({ length: 10 }, (_, index) => ({
        label: `Option ${index + 1}`,
        preview: index === 9 ? "NARROW_PREVIEW_BEGIN" : undefined,
      })),
    });

    for (let index = 0; index < 9; index += 1) component.handleInput("\x1b[B");

    const lines = component.render(40);
    expect(lines).toHaveLength(5);
    expect(lines.join("\n")).toContain("Option 10");
    expect(lines.join("\n")).toContain("NARROW_PREVIEW_BEGIN");
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true);
  });

  it("keeps a low focused preview visible in a wide split", () => {
    const tui = { terminal: { rows: 8 }, requestRender: vi.fn() };
    const { component } = make({
      tui: tui as never,
      allowFreeform: false,
      options: Array.from({ length: 10 }, (_, index) => ({
        label: `Option ${index + 1}`,
        preview: index === 9 ? "BOTTOM_PREVIEW_SENTINEL" : undefined,
      })),
    });

    for (let index = 0; index < 9; index += 1) component.handleInput("\x1b[B");

    const lines = component.render(100);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.join("\n")).toContain("Option 10");
    expect(lines.join("\n")).toContain("BOTTOM_PREVIEW_SENTINEL");
    expect(lines.join("\n")).toContain("PREVIEW · FOCUSED OPTION");
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    expect(lines.every(line => visibleWidth(line) <= 100)).toBe(true);
  });

  it("uses the configured submit key in editor help", () => {
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.input.submit": "ctrl+s",
    });
    const { component } = make({ keybindings, options: [{ label: "Only" }] });

    component.handleInput("\x1b[B");
    component.handleInput("\r");

    const output = component.render(80).join("\n");
    expect(output).toContain("ctrl+s save response");
    expect(output).not.toContain("Enter save response");
  });

  it("gives configured bindings precedence over fixed comment and Space actions", () => {
    const navigateWithC = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.down": "c",
    });
    const navigated = make({ keybindings: navigateWithC, allowMultiple: true });
    navigated.component.handleInput("c");
    expect(navigated.component.state.highlightedRow).toBe(1);
    expect(navigated.component.state.editor.kind).toBe("select");
    expect(navigated.component.render(120).join("\n")).not.toContain("c comment");

    const confirmWithC = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": "c",
    });
    const confirmed = make({ keybindings: confirmWithC });
    confirmed.component.handleInput("c");
    expect(confirmed.onSubmit).toHaveBeenCalledOnce();
    expect(confirmed.component.state.editor.kind).toBe("select");

    const confirmWithSpace = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": "space",
    });
    const freeform = make({
      keybindings: confirmWithSpace,
      options: [{ label: "Only" }],
      allowMultiple: true,
      allowFreeform: true,
    });
    freeform.component.handleInput("\x1b[B");
    freeform.component.handleInput(" ");
    expect(freeform.component.state.editor.kind).toBe("freeform");
    expect(freeform.component.state.freeformChecked).toBe(false);
    expect(freeform.component.render(120).join("\n")).not.toContain("Space/Space");
  });

  it("uses injected select keybindings and retains j/k aliases", () => {
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "w",
      "tui.select.down": "s",
      "tui.select.pageUp": "u",
      "tui.select.pageDown": "d",
      "tui.select.confirm": "x",
      "tui.select.cancel": "q",
    });
    const { component, onSubmit, onCancel } = make({ keybindings });

    component.handleInput("s");
    expect(component.state.highlightedRow).toBe(1);
    component.handleInput("w");
    expect(component.state.highlightedRow).toBe(0);
    component.handleInput("j");
    expect(component.state.highlightedRow).toBe(1);
    component.handleInput("k");
    expect(component.state.highlightedRow).toBe(0);
    expect(component.render(120).join("\n")).toContain("w/s/jk");

    component.handleInput("x");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();

    const cancelled = make({ keybindings });
    cancelled.component.handleInput("q");
    expect(cancelled.onCancel).toHaveBeenCalledOnce();
  });
});
