# Changelog

All notable changes to `@pi9/todo` will be documented in this file.

## [Unreleased]

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

[Unreleased]: https://github.com/Chase-C/pi9/compare/todo-v0.1.0...HEAD
[0.1.0]: https://github.com/Chase-C/pi9/releases/tag/todo-v0.1.0
