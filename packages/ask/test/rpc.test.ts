import { describe, expect, it, vi } from "vitest";
import { askWithRpc as askWithValidatedRpc, type AskDialogUI } from "../src/rpc.js";
import type { AskParams } from "../src/types.js";
import { validateAskParams } from "../src/validation.js";

function ui(select: (title: string, options: string[]) => Promise<string | undefined>, input: (title: string) => Promise<string | undefined>): AskDialogUI {
  return { select, input };
}

function askWithRpc(ui: AskDialogUI, params: AskParams, signal?: AbortSignal) {
  return askWithValidatedRpc(ui, validateAskParams(params), signal);
}

describe("ask RPC fallback", () => {
  it("uses select for an option and keeps its description", async () => {
    const select = vi.fn().mockResolvedValue("1. Blue — Calm");
    const input = vi.fn().mockResolvedValue("");

    const result = await askWithRpc(ui(select, input), {
      question: "Which color?",
      options: [{ label: "Blue", description: "Calm" }],
    });

    expect(select).toHaveBeenCalledWith("Which color?", ["1. Blue — Calm", "2. Type a response…"]);
    expect(input).toHaveBeenCalledWith('Which color?\n\nComment for "Blue" (optional):');
    expect(result).toEqual({
      selections: [{ label: "Blue", description: "Calm" }],
    });
  });

  it("uses input for the default freeform choice", async () => {
    const select = vi.fn().mockResolvedValue("1. Type a response…");
    const input = vi.fn().mockResolvedValue("   ");

    const result = await askWithRpc(ui(select, input), { question: "What next?", options: [] });

    expect(select).toHaveBeenCalledWith("What next?", ["1. Type a response…"]);
    expect(input).toHaveBeenCalledWith("What next?");
    expect(result).toEqual({ selections: [] });
  });

  it("returns null when a select or input dialog is cancelled", async () => {
    const cancelledSelect = await askWithRpc(
      ui(vi.fn().mockResolvedValue(undefined), vi.fn()),
      { question: "Continue?", options: [{ label: "Yes" }] },
    );
    expect(cancelledSelect).toBeNull();

    const cancelledInput = await askWithRpc(
      ui(vi.fn().mockResolvedValue("1. Type a response…"), vi.fn().mockResolvedValue(undefined)),
      { question: "Continue?", options: [] },
    );
    expect(cancelledInput).toBeNull();
  });

  it("supports multi-select with numbered comma-separated input", async () => {
    const select = vi.fn();
    const input = vi.fn()
      .mockResolvedValueOnce("3, 1, 3")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const result = await askWithRpc(ui(select, input), {
      question: "Which apply?",
      options: [
        { label: "One", description: "First" },
        { label: "Two" },
        { label: "Three", description: "Third" },
      ],
      allowMultiple: true,
      allowFreeform: false,
    });

    expect(select).not.toHaveBeenCalled();
    expect(input).toHaveBeenCalledWith(
      "Which apply?\n\n1. One — First\n2. Two\n3. Three — Third\n\nEnter option numbers separated by commas:",
    );
    expect(result).toEqual({
      selections: [
        { label: "One", description: "First" },
        { label: "Three", description: "Third" },
      ],
    });
  });

  it("combines multi-selections with a freeform response", async () => {
    const input = vi.fn()
      .mockResolvedValueOnce("2, 1")
      .mockResolvedValueOnce("  Also check accessibility  ")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const result = await askWithRpc(inputUi(input), {
      question: "What should change?",
      options: [{ label: "Docs" }, { label: "Tests" }],
      allowMultiple: true,
    });

    expect(input).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      selections: [{ label: "Docs" }, { label: "Tests" }],
      freeform: "Also check accessibility",
    });
  });

  it("collects comments in option order and allows each one to be skipped", async () => {
    const input = vi.fn()
      .mockResolvedValueOnce("3, 1")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("  Needs a migration note  ");

    const result = await askWithRpc(inputUi(input), {
      question: "Which changes?",
      options: [{ label: "Docs" }, { label: "Tests" }, { label: "Code" }],
      allowMultiple: true,
      allowFreeform: false,
    });

    expect(input.mock.calls[1]?.[0]).toContain('Comment for "Docs"');
    expect(input.mock.calls[2]?.[0]).toContain('Comment for "Code"');
    expect(result).toEqual({
      selections: [
        { label: "Docs" },
        { label: "Code", comment: "Needs a migration note" },
      ],
    });
  });

  it("cancels the whole answer if a comment dialog is cancelled", async () => {
    const input = vi.fn()
      .mockResolvedValueOnce("1, 2")
      .mockResolvedValueOnce("First comment")
      .mockResolvedValueOnce(undefined);

    const result = await askWithRpc(inputUi(input), {
      question: "Which?",
      options: [{ label: "One" }, { label: "Two" }],
      allowMultiple: true,
      allowFreeform: false,
    });

    expect(result).toBeNull();
  });

  it("distinguishes an option label matching the freeform text", async () => {
    const select = vi.fn().mockResolvedValue("1. Type a response…");
    const input = vi.fn().mockResolvedValue("");
    const result = await askWithRpc(ui(select, input), {
      question: "Choose",
      options: [{ label: "Type a response…" }],
    });

    expect(select.mock.calls[0]?.[1]).toEqual([
      "1. Type a response…",
      "2. Type a response…",
    ]);
    expect(result).toEqual({ selections: [{ label: "Type a response…" }] });
  });

  it("passes the abort signal to every dialog and stops a multi-step flow after abort", async () => {
    const controller = new AbortController();
    const input = vi.fn().mockImplementationOnce(async () => {
      controller.abort();
      return "1";
    });

    const result = await askWithRpc(inputUi(input), {
      question: "Choose",
      options: [{ label: "One" }],
      allowMultiple: true,
    }, controller.signal);

    expect(result).toBeNull();
    expect(input).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledWith(expect.any(String), undefined, { signal: controller.signal });
  });

  it("does not open a dialog when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const dialog = ui(vi.fn(), vi.fn());
    await expect(askWithRpc(dialog, { question: "Choose", options: [] }, controller.signal)).resolves.toBeNull();
    expect(dialog.select).not.toHaveBeenCalled();
  });
});

function inputUi(input: AskDialogUI["input"]): AskDialogUI {
  return { select: vi.fn().mockResolvedValue(undefined), input };
}
