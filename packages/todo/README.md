# @pi9/todo

A phased, branch-aware todo tool for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

## Features

- Phased plans with a flat-list shorthand for small tasks
- Stable task IDs for reliable updates and removal
- Explicit `pending`, `in_progress`, `completed`, and `cancelled` statuses
- State restored from the active Pi session branch
- A persistent, configurable todo widget above or below the editor
- Rich tool rendering with active-task summaries and expandable phase progress
- Native-style self-rendered tool shells with no extra spacing for hidden or completed activity

The agent can replace a plan, add tasks to a phase, update or move a task, remove a task, and view current state. Todo snapshots are stored in tool-result details, so `/tree` navigation restores the plan associated with that branch.

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
  "showCompleted": false,
  "fallbackGlyphs": false,
  "toolVisibility": "set-only"
}
```

`widgetPlacement` accepts `"aboveEditor"`, `"belowEditor"`, or `"off"`. `maxVisibleTasks` must be a positive integer, and `showCompleted` and `fallbackGlyphs` must be booleans. Nerd Font status glyphs are the default; set `fallbackGlyphs` to `true` to use the broadly supported `○`, `▶`, `✓`, and `×` symbols instead.

`toolVisibility` controls Todo tool output in the terminal UI only; it does not change tool availability, execution, or stored todo state. It defaults to `"set-only"`:

- `"all"` shows all Todo tool activity.
- `"set-only"` shows only `set` operations.
- `"none"` hides normal Todo tool activity.

Errors are always shown so failures remain visible regardless of `toolVisibility`. Invalid fields are ignored independently, leaving the default value (or the global value when an invalid project override is ignored).

Todo tool output uses native-style self-rendered shells: visible pending calls and final results receive one status/background shell, while hidden successful operations render zero lines with no extra spacing. When expanded, only the latest rendered `set` result on the active branch is live: later mutations refresh that view. Historical result details and collapsed rendering remain unchanged.

Settings are loaded when a session starts. The widget updates after todo mutations and when `/tree` restores another branch. Set `widgetPlacement` to `"off"` to disable it.

## Development

```bash
npm run typecheck --workspace @pi9/todo
npm test --workspace @pi9/todo
```
