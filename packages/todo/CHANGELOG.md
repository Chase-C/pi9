# Changelog

All notable changes to `@pi9/todo` will be documented in this file.

## [Unreleased]

## [0.1.0] - 2026-07-11

### Added

- Keep the latest expanded `set` result on the active branch live through later mutations while preserving historical result details and collapsed rendering.
- Add native-style self-rendered Todo tool shells with Pi background styling for pending, success, and error states while preserving visibility filtering and widget updates.
- Keep hidden successful operations at zero rendered lines with no extra spacing.
- Create the initial package scaffold.
- Add the phased todo tool, branch-aware session restoration, stable task IDs, and compact renderer.
- Add a persistent, configurable todo widget that follows session and branch state.
- Add validated global and trusted-project UI settings for widget placement, preview size, completed-task visibility, generic Unicode glyph fallback, and TUI-only Todo tool visibility.
- Enrich collapsed and expanded tool results with active-task context, numbered phase progress, status styling, and completion-transition metadata.

[Unreleased]: https://github.com/Chase-C/pi9/compare/todo-v0.1.0...HEAD
[0.1.0]: https://github.com/Chase-C/pi9/releases/tag/todo-v0.1.0
