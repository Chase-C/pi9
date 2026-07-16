# Changelog

## [Unreleased]

## [0.2.0] - 2026-07-16

### Changed

- Make the usage graph responsive to the available rows and columns, with a dynamic per-block token scale and at least one block for every non-zero category.
- Restyle the estimated breakdown with highlighted token values, muted percentages, and color-coded category markers.
- Use filled circles for most graph categories, a fisheye for conversation, and an outlined circle for free space.
- Move the keyboard controls into the bold report border and make the top content padding scroll away with the report.
- Refresh the README screenshot and responsive-graph verification guidance.

### Fixed

- Preserve complete breakdown values in side-by-side layouts by sizing the graph against the rendered summary width.

## [0.1.0] - 2026-07-09

### Added

- Add the `/context` command with an inline, scrollable context-usage report.
- Show prompt composition and token sizing for the active session.
- Show the configured auto-compaction reserve in the context graph and breakdown.
- Show the number of compactions on the current conversation branch.

### Fixed

- Attribute tool definitions, prompt snippets, and prompt guidelines to their tools without double-counting them in the system prompt.
- Include prompt wrappers and resource paths in memory-file and skill estimates.
- Show unknown context capacity accurately after compaction.
- Build reports from the current session and prompt configuration.
- Avoid opening terminal-only UI in non-TUI modes.
- Report active tool tokens consistently across summaries and details.

### Changed

- Add `u` and `d` aliases for paging through the context report.
- Simplify tool detail lines and remove the report capture-age line.
- Align development dependencies with Pi 0.80 and remove the unused `typebox` peer.

[Unreleased]: https://github.com/Chase-C/pi9/compare/context-v0.2.0...HEAD
[0.2.0]: https://github.com/Chase-C/pi9/compare/context-v0.1.0...context-v0.2.0
[0.1.0]: https://github.com/Chase-C/pi9/releases/tag/context-v0.1.0
