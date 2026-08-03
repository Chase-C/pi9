import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  AskSettingsStore,
  DEFAULT_ASK_SETTINGS,
  loadAskSettings,
  normalizeAskSettings,
} from "../src/settings.js";

describe("ask settings", () => {
  it("defaults to a five-minute reset-on-input timeout", () => {
    expect(DEFAULT_ASK_SETTINGS).toEqual({
      timeoutMs: 300_000,
      timeoutOnInput: "reset",
    });
    expect(normalizeAskSettings({}).settings).toEqual(DEFAULT_ASK_SETTINGS);
  });

  it.each(["never-reset", "reset", "cancel"] as const)("accepts the %s input behavior", (timeoutOnInput) => {
    expect(normalizeAskSettings({ timeoutMs: 12_000, timeoutOnInput })).toEqual({
      settings: { timeoutMs: 12_000, timeoutOnInput },
    });
  });

  it("keeps valid fields and defaults invalid fields with a warning", () => {
    expect(normalizeAskSettings({ timeoutMs: 2_500, timeoutOnInput: "pause" })).toEqual({
      settings: { timeoutMs: 2_500, timeoutOnInput: "reset" },
      warning: "Invalid ask timeoutOnInput; using reset.",
    });
    expect(normalizeAskSettings({ timeoutMs: 0, timeoutOnInput: "cancel" })).toEqual({
      settings: { timeoutMs: 300_000, timeoutOnInput: "cancel" },
      warning: "Invalid ask timeoutMs; using 300000.",
    });
  });

  it("loads settings from the user-level store and defaults a missing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ask-settings-"));
    const path = join(root, "settings.json");
    const store = new AskSettingsStore(path);

    await expect(store.load()).resolves.toEqual({ settings: DEFAULT_ASK_SETTINGS });
    await writeFile(path, JSON.stringify({ timeoutMs: 900, timeoutOnInput: "reset" }));
    await expect(store.load()).resolves.toEqual({
      settings: { timeoutMs: 900, timeoutOnInput: "reset" },
    });
  });

  it("notifies when loading fails and returns defaults", async () => {
    const notify = vi.fn();
    const settings = await loadAskSettings(
      { hasUI: true, ui: { notify } },
      { load: vi.fn().mockRejectedValue(new Error("broken")) },
    );

    expect(settings).toEqual(DEFAULT_ASK_SETTINGS);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("broken"), "warning");
  });
});
