import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  DEFAULT_TODO_SETTINGS,
  loadTodoSettings,
  normalizeTodoSettings,
} from "../src/settings.js";

test("todo UI settings use defaults when no settings file exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-settings-default-"));
  const result = await loadTodoSettings(undefined, { globalSettingsPath: join(root, "settings.json") });

  assert.deepEqual(result.settings, DEFAULT_TODO_SETTINGS);
  assert.deepEqual(result.settings, {
    widgetPlacement: "aboveEditor",
    maxVisibleTasks: 5,
    fallbackGlyphs: false,
    toolVisibility: "set-only",
    dynamicReminders: true,
    reminderMinTurns: 4,
    reminderMaxTurns: 8,
    reminderOutputTokens: 16000,
    reminderMaxPerRun: 2,
  });
  assert.equal(result.warning, undefined);
});

test("todo UI settings validate each field independently", () => {
  const result = normalizeTodoSettings({
    widgetPlacement: "belowEditor",
    maxVisibleTasks: 0,
    fallbackGlyphs: true,
    toolVisibility: "sometimes",
  });

  assert.deepEqual(result.settings, {
    widgetPlacement: "belowEditor",
    maxVisibleTasks: 5,
    fallbackGlyphs: true,
    toolVisibility: "set-only",
    dynamicReminders: true,
    reminderMinTurns: 4,
    reminderMaxTurns: 8,
    reminderOutputTokens: 16000,
    reminderMaxPerRun: 2,
  });
  assert.match(result.warning ?? "", /maxVisibleTasks/);
  assert.match(result.warning ?? "", /toolVisibility/);
});

test("todo reminder settings accept configured boolean and positive integers", () => {
  const result = normalizeTodoSettings({
    dynamicReminders: false,
    reminderMinTurns: 6,
    reminderMaxTurns: 12,
    reminderOutputTokens: 24000,
    reminderMaxPerRun: 3,
  });

  assert.deepEqual(result.settings, {
    widgetPlacement: "aboveEditor",
    maxVisibleTasks: 5,
    fallbackGlyphs: false,
    toolVisibility: "set-only",
    dynamicReminders: false,
    reminderMinTurns: 6,
    reminderMaxTurns: 12,
    reminderOutputTokens: 24000,
    reminderMaxPerRun: 3,
  });
  assert.equal(result.warning, undefined);
});

test("invalid reminder fields warn and default independently", () => {
  const result = normalizeTodoSettings({
    dynamicReminders: "false",
    reminderMinTurns: 0,
    reminderMaxTurns: 1.5,
    reminderOutputTokens: -1,
    reminderMaxPerRun: "2",
    fallbackGlyphs: true,
  });

  assert.deepEqual(result.settings, {
    widgetPlacement: "aboveEditor",
    maxVisibleTasks: 5,
    fallbackGlyphs: true,
    toolVisibility: "set-only",
    dynamicReminders: true,
    reminderMinTurns: 4,
    reminderMaxTurns: 8,
    reminderOutputTokens: 16000,
    reminderMaxPerRun: 2,
  });
  assert.match(result.warning ?? "", /dynamicReminders/);
  assert.match(result.warning ?? "", /reminderMinTurns/);
  assert.match(result.warning ?? "", /reminderMaxTurns/);
  assert.match(result.warning ?? "", /reminderOutputTokens/);
  assert.match(result.warning ?? "", /reminderMaxPerRun/);
});

test("a reminder turn range with max below min falls back to the prior complete range", () => {
  const result = normalizeTodoSettings({
    dynamicReminders: false,
    reminderMinTurns: 10,
    reminderMaxTurns: 6,
  });

  assert.equal(result.settings.dynamicReminders, false);
  assert.equal(result.settings.reminderMinTurns, 4);
  assert.equal(result.settings.reminderMaxTurns, 8);
  assert.match(result.warning ?? "", /reminderMaxTurns.*reminderMinTurns/);
});

test("trusted project settings override global todo settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-settings-trusted-"));
  const globalPath = join(root, "agent", "todo", "settings.json");
  const projectPath = join(root, "project", ".pi", "todo", "settings.json");
  await mkdir(join(root, "agent", "todo"), { recursive: true });
  await mkdir(join(root, "project", ".pi", "todo"), { recursive: true });
  await writeFile(
    globalPath,
    JSON.stringify({
      widgetPlacement: "belowEditor",
      maxVisibleTasks: 3,
      toolVisibility: "all",
      reminderMinTurns: 5,
      reminderMaxTurns: 10,
      reminderOutputTokens: 20000,
    }),
  );
  await writeFile(
    projectPath,
    JSON.stringify({
      maxVisibleTasks: 9,
      toolVisibility: "none",
      dynamicReminders: false,
      reminderMinTurns: 6,
      reminderMaxTurns: 12,
      reminderMaxPerRun: 4,
    }),
  );

  const result = await loadTodoSettings(
    { cwd: join(root, "project"), isProjectTrusted: () => true },
    {
      globalSettingsPath: globalPath,
      projectSettingsPath: cwd => join(cwd, ".pi", "todo", "settings.json"),
    },
  );

  assert.deepEqual(result.settings, {
    widgetPlacement: "belowEditor",
    maxVisibleTasks: 9,
    fallbackGlyphs: false,
    toolVisibility: "none",
    dynamicReminders: false,
    reminderMinTurns: 6,
    reminderMaxTurns: 12,
    reminderOutputTokens: 20000,
    reminderMaxPerRun: 4,
  });
});

test("an invalid project reminder range preserves the complete global range", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-settings-invalid-range-"));
  const globalPath = join(root, "agent", "todo", "settings.json");
  const projectPath = join(root, "project", ".pi", "todo", "settings.json");
  await mkdir(join(root, "agent", "todo"), { recursive: true });
  await mkdir(join(root, "project", ".pi", "todo"), { recursive: true });
  await writeFile(globalPath, JSON.stringify({ reminderMinTurns: 6, reminderMaxTurns: 10 }));
  await writeFile(projectPath, JSON.stringify({ reminderMinTurns: 12, reminderOutputTokens: 20000 }));

  const result = await loadTodoSettings(
    { cwd: join(root, "project"), isProjectTrusted: () => true },
    {
      globalSettingsPath: globalPath,
      projectSettingsPath: cwd => join(cwd, ".pi", "todo", "settings.json"),
    },
  );

  assert.equal(result.settings.reminderMinTurns, 6);
  assert.equal(result.settings.reminderMaxTurns, 10);
  assert.equal(result.settings.reminderOutputTokens, 20000);
  assert.match(result.warning ?? "", /reminderMaxTurns.*reminderMinTurns/);
});

test("untrusted projects do not load project-local todo settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "todo-settings-untrusted-"));
  const globalPath = join(root, "agent", "todo", "settings.json");
  const projectPath = join(root, "project", ".pi", "todo", "settings.json");
  await mkdir(join(root, "agent", "todo"), { recursive: true });
  await mkdir(join(root, "project", ".pi", "todo"), { recursive: true });
  await writeFile(globalPath, JSON.stringify({ maxVisibleTasks: 4, reminderMaxPerRun: 3 }));
  await writeFile(projectPath, JSON.stringify({ dynamicReminders: false, reminderMaxPerRun: 9 }));

  const result = await loadTodoSettings(
    { cwd: join(root, "project"), isProjectTrusted: () => false },
    {
      globalSettingsPath: globalPath,
      projectSettingsPath: cwd => join(cwd, ".pi", "todo", "settings.json"),
    },
  );

  assert.deepEqual(result.settings, {
    widgetPlacement: "aboveEditor",
    maxVisibleTasks: 4,
    fallbackGlyphs: false,
    toolVisibility: "set-only",
    dynamicReminders: true,
    reminderMinTurns: 4,
    reminderMaxTurns: 8,
    reminderOutputTokens: 16000,
    reminderMaxPerRun: 3,
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

  const result = await loadTodoSettings(
    { cwd: join(root, "project"), isProjectTrusted: () => true },
    {
      globalSettingsPath: globalPath,
      projectSettingsPath: cwd => join(cwd, ".pi", "todo", "settings.json"),
    },
  );

  assert.equal(result.settings.toolVisibility, "all");
  assert.match(result.warning ?? "", /toolVisibility/);
});
