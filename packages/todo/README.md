# @pi9/todo

A phased, branch-aware todo tool for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

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

## Tool contract

The provider-facing schema is one flat object rather than a union, which keeps it compatible across Pi providers. Action-specific requirements are validated atomically by the tool.

### Set the complete plan

`set` discards the complete current plan and creates exactly the supplied phases and tasks. Every task starts `pending`. An empty `phases` array clears the plan.

```json
{
  "action": "set",
  "phases": [
    {
      "name": "Build",
      "tasks": ["Implement session restoration", "Add integration coverage"]
    }
  ]
}
```

### Add newly discovered work

`add` creates missing phases or appends tasks to existing phases without changing current tasks or statuses. New tasks start `pending`.

```json
{
  "action": "add",
  "phases": [
    {
      "name": "Verify",
      "tasks": ["Run the complete test suite"]
    }
  ]
}
```

### Transition task statuses

`transition` applies status changes atomically using exact phase and task names.

```json
{
  "action": "transition",
  "transitions": [
    {
      "phase": "Build",
      "task": "Implement session restoration",
      "status": "completed"
    },
    {
      "phase": "Verify",
      "task": "Run the complete test suite",
      "status": "in_progress"
    }
  ]
}
```

Phase names and task names are immutable. Task names must be unique within their phase. Cancel obsolete tasks instead of removing them; cancel and add a corrected task when its name needs to change. All `in_progress` tasks must belong to one phase.

### View the plan

`view` returns the complete plan or one exact phase:

```json
{ "action": "view", "phase": "Build" }
```

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
  "toolVisibility": "set-only"
}
```

`widgetPlacement` accepts `"aboveEditor"`, `"belowEditor"`, or `"off"`. `maxVisibleTasks` must be a positive integer, and `fallbackGlyphs` must be a boolean. Nerd Font status glyphs are the default; set `fallbackGlyphs` to `true` to use broadly supported Unicode symbols instead.

`toolVisibility` controls Todo tool output in the terminal UI only:

- `"all"` shows every Todo action.
- `"set-only"` shows only `set` operations.
- `"none"` hides normal Todo activity.

Errors are always shown. Todo output uses native-style self-rendered shells, and hidden successful operations render zero lines. When expanded, the latest rendered `set` result on the active branch follows later additions and transitions; historical details and collapsed rendering remain unchanged.

Settings load when a session starts. The widget refreshes after todo changes and `/tree` navigation. Set `widgetPlacement` to `"off"` to disable it.

## Development

```bash
npm run typecheck --workspace @pi9/todo
npm test --workspace @pi9/todo
```
