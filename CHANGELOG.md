# Changelog

This changelog starts with changes made after the last released tag, `v0.1.1`.

## [Unreleased] - 2026-05-29

### Added

- Render background subagent completion notifications with compact and expanded views, themed statuses, elapsed times, and session IDs when expanded.
- Emit subagent lifecycle events for generic updates plus queued, started, and completed milestones.
- Persist terminal subagent session metadata to a `subagent-session-index` custom entry, including status, timing, prompt previews, and output/error snippets.
- Warn before switching or forking sessions while subagents are still queued or running.
- Add `/subagents` argument completions and direct `agents` / `sessions` views.

### Changed

- Load inherited child-session extensions through Pi's native resource loader and module cache.
- Supply recursive child-session subagent context through SDK custom tools instead of inline extension factories.
- Improve subagent resume messages with themed statuses and an expanded labeled-detail layout.
- Update README installation guidance to use `pi install npm:@pi9/subagent`.

### Fixed

- Exclude the root `@pi9/subagent` extension from inherited child extension paths, preventing duplicate managers and lifecycle setup.
- Preserve Pi compatibility aliases when inherited extensions import legacy `@earendil-works/pi-ai` exports.
- Ensure resumed subagent attempts emit fresh queued, started, and completed lifecycle events instead of being deduplicated as prior attempts.

### Tests

- Add coverage for native inherited extension loading, canonical self-exclusion, SDK child tools, and recursive shared-manager behavior.
- Add coverage for lifecycle events, session metadata persistence, session guards, command completions, background completion rendering, and resume message rendering.

[Unreleased]: https://github.com/Chase-C/pi9_subagent/compare/v0.1.1...HEAD
