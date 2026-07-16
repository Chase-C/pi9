# Changelog

All notable changes to `@pi9/todo` will be documented in this file.

## [Unreleased]

### Changed

- Simplify Todo tool calls by removing lifecycle labels and expansion hints, and show a muted live phase/task summary while arguments stream and after completion.
- Use the muted theme color instead of dim for secondary Todo widget text.
- Match expanded tool output to widget phase progress and task colors, and remove the redundant `Todos` heading.

## [0.3.1] - 2026-07-15

### Changed

- Dim the active task's status icon while keeping its text at the normal color.
- Refine the working indicator's styling and distinguish active and idle states.
- Add a one-character outer margin to the widget.

## [0.3.0] - 2026-07-14

### Changed

- Require `set` and `add` to contain non-empty phases with described tasks, expose descriptions in full-plan `view` results and model reminders, and reject persisted phases or tasks that do not meet those requirements.
- Require fresh `workingOn` text on every transition that leaves tasks `in_progress`, clear it when work becomes terminal, and include it in views and model reminders.
- Change `view` to return only the full plan rather than filtering by phase.
- Streamline the model-facing tool description and guidance around planning, status transitions, verification, and current-work summaries.
- Simplify widget headings and phase progress, keep active-task status glyphs static, and show current-work text on a separate dimmed line with Pi's standard spinner.
- Keep the final terminal widget summary visible for five seconds before clearing it, including across repeated terminal-state refreshes.
- Refresh the README with a product screenshot and a concise, user-focused overview of features and settings.

## [0.2.0] - 2026-07-13

### Added

- Add configurable, transient plan reminders based on agent turns and output tokens, with per-run limits and resets after Todo interactions.
- Restore the full phased plan to model context once after manual or automatic compaction without altering session history or compaction summaries.

### Changed

- Refine model-facing Todo guidance to keep plans and task statuses current.
- Add spacing below the above-editor Todo widget.

## [0.1.0] - 2026-07-11

### Added

- Add a provider-compatible phased planning tool with atomic `set`, `add`, `transition`, and `view` operations, immutable name-addressed tasks, and branch-aware state restoration.
- Add compact and expanded task rendering with phase progress, status styling, completion metadata, live plan updates, and native tool shells.
- Add a persistent configurable widget with focused phase previews, terminal-task summaries, animated activity markers, and flexible placement.
- Add validated global and trusted-project settings for widget presentation, glyph fallback, and tool-output visibility.

[Unreleased]: https://github.com/Chase-C/pi9/compare/todo-v0.3.1...HEAD
[0.3.1]: https://github.com/Chase-C/pi9/compare/todo-v0.3.0...todo-v0.3.1
[0.3.0]: https://github.com/Chase-C/pi9/compare/todo-v0.2.0...todo-v0.3.0
[0.2.0]: https://github.com/Chase-C/pi9/compare/todo-v0.1.0...todo-v0.2.0
[0.1.0]: https://github.com/Chase-C/pi9/releases/tag/todo-v0.1.0
