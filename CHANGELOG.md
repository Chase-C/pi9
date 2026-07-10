# Changelog

This changelog starts with version `v0.2.1`.

## [Unreleased]

### Added

- Add concise tool metadata and delegation guidance for deciding when and how to use subagents.
- Add dedicated model-facing projections for agent discovery and session inventory.
- Expose resolved model, thinking, working directory, skills, tools, and resumability as `effectiveConfig` in results and inventory.

### Changed

- Streamline the tool description and move action mechanics into the provider-compatible schema.
- Clarify foreground/background behavior, result retention, conversation resumability, session IDs, and removal scopes.
- Report agent defaults as `defaultResumable` and normalize model-facing statuses and capabilities.
- Hide sessions from inventory as soon as removal begins.
- Update the release script to create dated changelog sections and include their entries in GitHub Release notes.

### Fixed

- Suppress stale background notifications after removal, result retrieval, or the start of a matching `results` call.
- Improve errors for follow-ups to non-resumable sessions.
- Reject empty task and session arrays, empty identifiers and overrides, and unsupported thinking levels.

## [0.2.1] - 2026-07-09

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

[Unreleased]: https://github.com/Chase-C/pi9_subagent/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Chase-C/pi9_subagent/compare/v0.1.1...v0.2.1
