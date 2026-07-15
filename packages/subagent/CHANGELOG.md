# Changelog

This changelog starts with version `v0.2.1`.

## [Unreleased]

### Breaking

- Drop compatibility with persisted tool details and custom-message payloads from earlier releases; old subagent rows and notifications are no longer re-rendered.
- Remove deprecated deep-module APIs, legacy lifecycle shapes, direct action-handler call signatures, and migration handling for removed tool fields.

### Changed

- Make attempt kind, requested configuration, and catalog retention the canonical owners of resume state, task overrides, and session persistence.
- Move task resolution out of `Agent`, model preflight failures directly, centralize tool invocation parsing, and eliminate source import cycles.
- Report task-level skill overrides consistently in session and preflight snapshots, including explicit empty skill lists.
- Require non-blank agent descriptions and validate definition thinking levels against `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Unify command- and model-facing safe removal capability as `canRemove`: terminal cataloged background and resumable sessions are removable, while active sessions are not advertised as removable. Details payloads retain deprecated `canClear` as an equivalent alias.
- Consolidate settings updates and background-completion message projection while keeping current tool, event, and message shapes unchanged.
- Reject non-boolean `run.background` and `results.remove` values at the runtime parsing boundary.
- Refine tool-call titles with a bold tool name and a dimmed run/results summary.
- Redesign run and results rows around task labels, tool-call counts, token usage, elapsed time, recent activity, and lightweight nested-agent rails.

### Fixed

- Render pending `results` entries consistently with run rows while using a static running glyph instead of a frozen spinner frame.
- Keep top-level tool activity, nested connectors, wrapped continuation lines, and tree-rail colors aligned consistently.

### Tests

- Add lifecycle, retention, task-resolution, parser, settings, notification, and recursive orchestration characterization coverage.

## [0.3.1] - 2026-07-11

### Fixed

- Always show spawned session handles in background run results, including the collapsed view.
- Render in-progress result polls with a static status instead of a frozen spinner.
- Refresh the subagent widget after result collection or explicit removal clears sessions.

## [0.3.0] - 2026-07-09

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

[Unreleased]: https://github.com/Chase-C/pi9/compare/subagent-v0.3.1...HEAD
[0.3.1]: https://github.com/Chase-C/pi9/compare/v0.3.0...subagent-v0.3.1
[0.3.0]: https://github.com/Chase-C/pi9/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Chase-C/pi9/compare/v0.1.1...v0.2.1
