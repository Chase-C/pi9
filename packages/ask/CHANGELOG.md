# Changelog

All notable changes to `@pi9/ask` will be documented in this file.

## [Unreleased]

## [0.1.0] - 2026-07-12

### Added

- Add a sequential `ask` tool with single-select, multi-select, option comments, and freeform responses across TUI and RPC modes.
- Add a keyboard-driven questionnaire with descriptions, comment editing, cancellation, and compact response guidance.
- Add branch-aware re-answering from the session tree with hidden durable revision markers and model-context projection.

### Changed

- Render pending questions with their response type, then replace the answer summary with an indented option list using Nerd Font selection glyphs.
- Update the original Ask tool row when an answer is revised instead of displaying a separate revision message.
- Prune completed Ask calls with a schema-valid historical marker while retaining structured answer details.

[Unreleased]: https://github.com/Chase-C/pi9/compare/ask-v0.1.0...HEAD
[0.1.0]: https://github.com/Chase-C/pi9/releases/tag/ask-v0.1.0
