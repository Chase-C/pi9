# @pi9/todo

A phased, session-aware todo tool for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

## Features

- Concise phased plans with immutable task names
- Destructive plan replacement and non-destructive task addition
- Atomic status transitions addressed by exact phase and task names
- Explicit `pending`, `in_progress`, `completed`, and `cancelled` statuses
- State restored from the active Pi session branch
- A persistent, configurable todo widget above or below the editor
- Rich tool rendering with active-task summaries and expandable phase progress
- Native-style self-rendered tool shells with no extra spacing for hidden activity

Todo snapshots are stored in tool-result details, so `/tree` navigation restores the plan associated with that branch.

## Install

```bash
pi install npm:@pi9/todo
```

For local development:

```bash
pi -e ./packages/todo/src/index.ts
```

## UI settings

The settings loader reads global settings from `~/.pi/agent/todo/settings.json`. For a trusted project, `.pi/todo/settings.json` overrides the global values. Pi's project-trust decision is required before the project file is read; an untrusted project cannot affect these settings.

```json
{
  "widgetPlacement": "aboveEditor",
  "maxVisibleTasks": 5,
  "fallbackGlyphs": false,
  "toolVisibility": "set-only",
  "dynamicReminders": true,
  "reminderMinTurns": 4,
  "reminderMaxTurns": 8,
  "reminderOutputTokens": 16000,
  "reminderMaxPerRun": 2
}
```

`widgetPlacement` accepts `"aboveEditor"`, `"belowEditor"`, or `"off"`. `maxVisibleTasks` must be a positive integer, and `fallbackGlyphs` must be a boolean. Nerd Font status glyphs are the default; set `fallbackGlyphs` to `true` to use broadly supported Unicode symbols instead.

`toolVisibility` controls Todo tool output in the terminal UI only:

- `"all"` shows every Todo action.
- `"set-only"` shows only `set` operations.
- `"none"` hides normal Todo activity.

Errors are always shown. Todo output uses native-style self-rendered shells, and hidden successful operations render zero lines. When expanded, the latest rendered `set` result on the active branch follows later additions and transitions; historical details and collapsed rendering remain unchanged.

Dynamic reminders are transient user-role context messages: they are supplied to the model only for the current request and are never added to session history. A reminder is due only after `reminderMinTurns`, then when either `reminderMaxTurns` or `reminderOutputTokens` is reached, up to `reminderMaxPerRun` times per agent run. This guarded-OR cadence prevents reminders during short bursts while still catching either many small turns or a few output-heavy turns. Output tokens are counted because model-generated work, rather than prompt size, is the useful signal that a plan may have become stale. Any successful Todo action, including `view`, resets the turn/token window at the end of that turn; failed actions do not. Set `dynamicReminders` to `false` to disable reminders.

After a successful manual, threshold, or overflow Pi compaction, the extension injects a one-shot transient full phased plan into the next model context build. It includes every phase and task with literal statuses, including `completed` and `cancelled` tasks and terminal-only plans; plans with zero tasks are skipped. This does not change Pi's compaction summary or session history. The injection takes priority over a due dynamic cadence reminder and resets its staleness window, regardless of `dynamicReminders`. Its pending state is in memory only and is cleared on session start/reload or `/tree` navigation, so it is not persisted across an extension reload before delivery.

Settings load when a session starts. The widget refreshes after todo changes and `/tree` navigation. Set `widgetPlacement` to `"off"` to disable it.

## Development

```bash
npm run typecheck --workspace @pi9/todo
npm test --workspace @pi9/todo
```
