# Changelog

All notable changes to `@pi9/ask` will be documented in this file.

## [Unreleased]

## [0.3.1] - 2026-07-17

### Changed

- Replace trailing `[selected]` badges in active multi-select questionnaires with checkbox glyphs beside the selection bar, using normal text color for the focused unchecked checkbox.

### Fixed

- Show the revised answer beside `[ask:reanswer]` entries in the `/tree` history view.

## [0.3.0] - 2026-07-17

### Changed

- Store selected options by index so the original Ask call is the sole source of labels, descriptions, question text, and selection mode.
- Reduce answer revisions to hidden records containing only the source tool-call ID and user-authored answer data.
- Consolidate schemas, normalization, answer formatting, and result construction into one domain module, and session replay and context rewriting into one session module.

### Removed

- Remove the dedicated revision-message renderer and editor-restoration workaround; revision records now have empty hidden content.

## [0.2.0] - 2026-07-16

### Changed

- Redesign wide preview questionnaires as framed two-column dialogs with option and preview headers.
- Use a selection bar for keyboard focus and `[selected]` badges for checked multi-select options.
- Render secondary Ask tool-call and completed-answer text with the muted theme color instead of dim styling.

### Fixed

- Preserve wide-layout headers while editing freeform responses and place comment editors directly below their target options.
- Align wrapped option labels and completed freeform responses with their first-line text.

## [0.1.0] - 2026-07-14

### Added

- Add a focused, sequential `ask` tool for interactive questions in TUI and RPC modes.
- Add keyboard-driven single- and multi-select questionnaires with option descriptions, comments, freeform responses, cancellation, and configurable timeouts.
- Add responsive Markdown previews with layouts that adapt to terminal width and height.
- Add compact question and answer rendering with concise model context for completed exchanges.
- Add branch-aware answer revisions from the session tree.

[Unreleased]: https://github.com/Chase-C/pi9/compare/ask-v0.3.1...HEAD
[0.3.1]: https://github.com/Chase-C/pi9/compare/ask-v0.3.0...ask-v0.3.1
[0.3.0]: https://github.com/Chase-C/pi9/compare/ask-v0.2.0...ask-v0.3.0
[0.2.0]: https://github.com/Chase-C/pi9/compare/ask-v0.1.0...ask-v0.2.0
[0.1.0]: https://github.com/Chase-C/pi9/releases/tag/ask-v0.1.0
