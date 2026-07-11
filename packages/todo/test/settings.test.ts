import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  DEFAULT_TODO_UI_SETTINGS,
  TodoUiSettingsStore,
  normalizeTodoUiSettings,
} from "../src/settings.js";

test("todo UI settings use defaults when no settings file exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-settings-default-"));
  const result = await new TodoUiSettingsStore({ globalSettingsPath: join(root, "settings.json") }).load();

  assert.deepEqual(result.settings, DEFAULT_TODO_UI_SETTINGS);
  assert.equal(result.warning, undefined);
});

test("todo UI settings validate each field independently", () => {
  const result = normalizeTodoUiSettings({
    widgetPlacement: "belowEditor",
    maxVisibleTasks: 0,
    showCompleted: "yes",
    fallbackGlyphs: true,
    toolVisibility: "sometimes",
  });

  assert.deepEqual(result.settings, {
    widgetPlacement: "belowEditor",
    maxVisibleTasks: 5,
    showCompleted: false,
    fallbackGlyphs: true,
    toolVisibility: "set-only",
  });
  assert.match(result.warning ?? "", /maxVisibleTasks/);
  assert.match(result.warning ?? "", /showCompleted/);
  assert.match(result.warning ?? "", /toolVisibility/);
});

test("trusted project settings override global todo settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-settings-trusted-"));
  const globalPath = join(root, "agent", "todo", "settings.json");
  const projectPath = join(root, "project", ".pi", "todo", "settings.json");
  await mkdir(join(root, "agent", "todo"), { recursive: true });
  await mkdir(join(root, "project", ".pi", "todo"), { recursive: true });
  await writeFile(globalPath, JSON.stringify({ widgetPlacement: "belowEditor", maxVisibleTasks: 3, toolVisibility: "all" }));
  await writeFile(projectPath, JSON.stringify({ maxVisibleTasks: 9, showCompleted: true, toolVisibility: "none" }));

  const store = new TodoUiSettingsStore({
    globalSettingsPath: globalPath,
    projectSettingsPath: cwd => join(cwd, ".pi", "todo", "settings.json"),
  });
  const result = await store.load({ cwd: join(root, "project"), isProjectTrusted: () => true });

  assert.deepEqual(result.settings, {
    widgetPlacement: "belowEditor",
    maxVisibleTasks: 9,
    showCompleted: true,
    fallbackGlyphs: false,
    toolVisibility: "none",
  });
});

test("untrusted projects do not load project-local todo settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-settings-untrusted-"));
  const globalPath = join(root, "agent", "todo", "settings.json");
  const projectPath = join(root, "project", ".pi", "todo", "settings.json");
  await mkdir(join(root, "agent", "todo"), { recursive: true });
  await mkdir(join(root, "project", ".pi", "todo"), { recursive: true });
  await writeFile(globalPath, JSON.stringify({ maxVisibleTasks: 4 }));
  await writeFile(projectPath, "not json");

  const store = new TodoUiSettingsStore({
    globalSettingsPath: globalPath,
    projectSettingsPath: cwd => join(cwd, ".pi", "todo", "settings.json"),
  });
  const result = await store.load({ cwd: join(root, "project"), isProjectTrusted: () => false });

  assert.deepEqual(result.settings, {
    widgetPlacement: "aboveEditor",
    maxVisibleTasks: 4,
    showCompleted: false,
    fallbackGlyphs: false,
    toolVisibility: "set-only",
  });
  assert.equal(result.warning, undefined);
});

test("invalid project tool visibility preserves the global value", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-settings-invalid-project-"));
  const globalPath = join(root, "agent", "todo", "settings.json");
  const projectPath = join(root, "project", ".pi", "todo", "settings.json");
  await mkdir(join(root, "agent", "todo"), { recursive: true });
  await mkdir(join(root, "project", ".pi", "todo"), { recursive: true });
  await writeFile(globalPath, JSON.stringify({ toolVisibility: "all" }));
  await writeFile(projectPath, JSON.stringify({ toolVisibility: "invalid" }));

  const store = new TodoUiSettingsStore({
    globalSettingsPath: globalPath,
    projectSettingsPath: cwd => join(cwd, ".pi", "todo", "settings.json"),
  });
  const result = await store.load({ cwd: join(root, "project"), isProjectTrusted: () => true });

  assert.equal(result.settings.toolVisibility, "all");
  assert.match(result.warning ?? "", /toolVisibility/);
});
