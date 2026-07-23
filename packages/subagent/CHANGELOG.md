# Changelog

This changelog starts with version `v0.2.1`.

## [Unreleased]

### Documentation

- Restore the README feature overview, including the minimal tool prompt size that reduces parent-context bloat.

## [0.7.1] - 2026-07-23

### Changed

- Redesign the subagent widget around a default retained-conversation summary and an opt-in active-run progress mode. Legacy `widgetLayout` values migrate to `widgetMode` on load.

### Documentation

- Refresh the README with current screenshots for the complete tool lifecycle, parallel progress, and recursive delegation, and focus setup guidance on defining agents rather than model-facing tool calls.

## [0.7.0] - 2026-07-23

### Breaking

- Replace the prior dispatch and retrieval lifecycle with five actions: `agents`, pure output-free `list`, always-asynchronous `run`, exact-run blocking `join`, and explicit batched conversation `remove`.
- Give every spawned conversation a process-local adjective-noun `conversationId` and every attempt a verb-adverb `runId`; `join` has no timeout, and cancelling it stops only the wait rather than the underlying run.
- Keep every conversation until explicit removal. Allow follow-ups only after completed runs or interrupted runs that preserved conversation context.
- Add a `maxConversations` runtime limit, defaulting to 100, which rejects new spawns at capacity until conversations are removed.
- Define completion notifications in terms of unacknowledged runs; inventory remains side-effect free and does not acknowledge completion.
- Remove the previous dispatch modes, nonblocking retrieval action, session identifier, and opt-in conversation-retention contract without compatibility aliases.

### Documentation

- Rewrite the README around conversations and exact runs, including action semantics, capacity, cleanup, notifications, migration guidance, and the runtime-local lifetime of child context.

## [0.6.0] - 2026-07-17

### Breaking

- Replace the lifecycle contract with immutable spawn-time conversation policy (`retainConversation`), attempt-scoped foreground/background `dispatch`, and attempt-scoped history.
- Replace lifecycle snapshot and result fields with structured attempt, conversation, retention, and capability projections. No migration code, compatibility aliases, or compatibility projections are provided; legacy task/frontmatter fields are rejected and the old settings key is ignored.
- Make spawn policy and label immutable: resume tasks accept only a session handle and prompt.

### Added

- Add filterable flat/tree session projections, with running descendants nested under their parents and retained terminal sessions kept at the root.
- Add a full-width conversation mode for running and resumable sessions, with direct messaging and live transcript updates.

### Changed

- Centralize catalog, conversation, result, resume/remove, and widget decisions around retention reasons and capabilities.
- Replace the separate `/subagents` dialogs with one overlay for Sessions, Agents, and Settings.
- Rename the widget section to Retained and derive membership from retention reasons and capabilities.
- Let users enter a conversation from Sessions and message a running subagent directly.

### Fixed

- Drop queued background completion notifications when a later foreground or background attempt supersedes them.

## [0.5.1] - 2026-07-16

### Changed

- Redesign expanded foreground and result rows around labeled Task, Previous Run, Tools, Subagents, and Answer sections; cap tools to the three newest calls and retain recursive child summaries in final results.

### Fixed

- Restore compatibility with Pi 0.80.8 and later by removing the retired `CreateAgentSessionOptions.modelRegistry` option from child-session creation.

## [0.5.0] - 2026-07-16

### Breaking

- Replace UUID session IDs with process-local adjective-noun handles such as `quiet-otter`; existing UUIDs cannot be resumed, queried, or removed.
- Limit `list` entries to session identity, normalized status, dispatch mode, and resume/remove capabilities; use `results` for full output and errors.
- Require every new-session task to include a non-empty `label`; labels remain optional when resuming a session.
- Remove scope-based cleanup; `remove` now requires explicit `sessionIds` for every session to abort or discard.

### Changed

- Render `list` as concise status-and-identity rows, with session metadata shown when expanded.
- Collapse background `run` results to a started count, with agent names, labels, and session handles shown when expanded.
- Clarify tool metadata and schema descriptions for agent discovery, context isolation, concurrent tasks, background dispatch, result retrieval, and cleanup.

### Fixed

- Report background preflight failures alongside any successfully started session handles instead of silently omitting them.
- Reject empty `list` status filters consistently in both the provider schema and runtime validation.

### Documentation

- Update the README introduction, examples, and tool reference for readable handles, required labels, lightweight inventory, and explicit cleanup.

## [0.4.0] - 2026-07-15

### Breaking

- Remove compatibility with legacy persisted render/notification payloads and deprecated deep-module APIs.

### Changed

- Tighten agent and tool-input validation for descriptions, thinking levels, and boolean flags.
- Make task-level skill overrides authoritative, including `skills: []`, and inject selected skills' full instructions into child system prompts.
- Consistently expose removal capability for terminal cataloged sessions across the tool and `/subagents` UI.
- Redesign run, result, and background-completion rows around task labels, activity, usage, elapsed time, and nested-agent structure.

### Fixed

- Render pending results and agent activity with consistent statuses, rails, wrapping, and alignment.

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

[Unreleased]: https://github.com/Chase-C/pi9/compare/subagent-v0.7.1...HEAD
[0.7.1]: https://github.com/Chase-C/pi9/compare/subagent-v0.7.0...subagent-v0.7.1
[0.7.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.6.0...subagent-v0.7.0
[0.6.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.5.1...subagent-v0.6.0
[0.5.1]: https://github.com/Chase-C/pi9/compare/subagent-v0.5.0...subagent-v0.5.1
[0.5.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.4.0...subagent-v0.5.0
[0.4.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.3.1...subagent-v0.4.0
[0.3.1]: https://github.com/Chase-C/pi9/compare/v0.3.0...subagent-v0.3.1
[0.3.0]: https://github.com/Chase-C/pi9/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Chase-C/pi9/compare/v0.1.1...v0.2.1
