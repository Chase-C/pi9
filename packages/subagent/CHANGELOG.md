# Changelog

This changelog starts with version `v0.2.1`.

## [Unreleased]

## [0.9.0] - 2026-07-29

### Added

- Include compact, bounded terminal error diagnostics in `inspect` without exposing output or acknowledging outcomes.
- Expose `parentRunId`, `rootRunId`, and `depth` through `list` and `inspect` so recursive run trees are machine-readable.
- Include explicit requested overrides and resolved effective execution configuration in `inspect` when available.

### Changed

- Notify only for unseen terminal outcomes: terminal inspection and successful cancellation now suppress redundant completion messages without acknowledging run output.
- Coalesce newly settled runs behind a fixed grace window while tool-call-scoped inspect, cancel, and join claims protect exact targets across root and recursive agents.
- Shorten completion copy and describe `join` as retrieving terminal outcomes rather than always retrieving output.
- Defer completion delivery until synchronous tool preflight settles so same-batch joins can claim their runs without redundant notifications.
- Report the exact queued or running run that prevents a conversation from being resumed, with status-appropriate next steps.
- Describe terminal subagents as “finished” in notification headers so aborted and failed runs are not collectively called completed.
- Allow cancelled conversations to resume after SDK abortion and execution cleanup have both settled.

### Breaking

- Return `{ action, results }` for processed commands and `{ action, error }` for command-level failures. Ordered batch entries use `{ ok: true, data }` or `{ ok: false, error }`.
- Replace `dispatch(tasks)` and `run(spawns?, resumes?)` with separate `spawn(spawns)`, `resume(resumes)`, and `steer(messages)` actions; there are no compatibility aliases.
- Split the shared task schema into distinct spawn, resume, and steer item schemas and remove redundant field descriptions.
- Return malformed, unknown, and unauthorized batch targets as ordered per-item errors instead of rejecting valid siblings.
- Add `cancel(runIds)` for stopping exact queued or running runs while retaining their conversations and aborted outcomes.
- Make `remove(conversationIds)` reject active conversations and permanently delete terminal conversations with all associated run records; removed runs are no longer inspectable or joinable.
- Preserve recursive access by reparenting surviving descendant ownership when an intermediate conversation is removed, and suppress stale updates from join bindings to deleted conversations.

## [0.8.2] - 2026-07-28

### Changed

- Show elapsed time, turns, and token usage for top-level and recursive runs in `join` tool rendering, using the same formatting as the conversation overlay.

## [0.8.1] - 2026-07-28

### Added

- Add per-run steer receipts with queued, delivered, processed, and discarded lifecycle states.
- Add inspect-only running phases without changing the stable run status vocabulary.

### Changed

- Return ordered per-target errors from `inspect` so malformed, unknown, or unauthorized targets do not hide valid sibling snapshots.
- Wait for in-flight steering to finalize during removal so discarded receipts remain inspectable and queued messages cannot continue after abort.

## [0.8.0] - 2026-07-28

### Breaking

- Rename the `run` action to `dispatch` without a compatibility alias. Dispatch tasks now use exactly one of `agent` (spawn), `conversationId` (resume), or `runId` (steer).

### Added

- Add exact-run steering through `{ runId, prompt }` dispatch tasks, including ordered batching and recursive descendant authorization.
- Add pure `inspect(runIds)` snapshots with bounded partial-message and recent-tool activity; inspection does not expose terminal output or acknowledge completion.

## [0.7.4] - 2026-07-26

### Added
- Expand identifier word lists

### Changed

- Update Pi development dependencies to 0.82.1.

## [0.7.3] - 2026-07-24

### Changed

- Redesign `/subagents` settings as a padded inspector with contextual previews, direct numeric entry, and dependency-aware progress-row controls.

## [0.7.2] - 2026-07-24

### Changed

- Refine the `/subagents` overlay with a framed header, pinned filters, reverse tab navigation, stable overflow counts, and consistent selected-row styling.
- Sort agents by name and conversations newest-first while preserving selection and rendering recursive conversations with muted, continuous tree connectors.
- Enrich conversation rows and details with explicit task-level model/thinking overrides, elapsed time, token and compaction usage, previous-run metadata, and nested subagent activity trees.

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

[Unreleased]: https://github.com/Chase-C/pi9/compare/subagent-v0.9.0...HEAD
[0.9.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.8.2...subagent-v0.9.0
[0.8.2]: https://github.com/Chase-C/pi9/compare/subagent-v0.8.1...subagent-v0.8.2
[0.8.1]: https://github.com/Chase-C/pi9/compare/subagent-v0.8.0...subagent-v0.8.1
[0.8.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.7.4...subagent-v0.8.0
[0.7.4]: https://github.com/Chase-C/pi9/compare/subagent-v0.7.3...subagent-v0.7.4
[0.7.3]: https://github.com/Chase-C/pi9/compare/subagent-v0.7.2...subagent-v0.7.3
[0.7.2]: https://github.com/Chase-C/pi9/compare/subagent-v0.7.1...subagent-v0.7.2
[0.7.1]: https://github.com/Chase-C/pi9/compare/subagent-v0.7.0...subagent-v0.7.1
[0.7.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.6.0...subagent-v0.7.0
[0.6.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.5.1...subagent-v0.6.0
[0.5.1]: https://github.com/Chase-C/pi9/compare/subagent-v0.5.0...subagent-v0.5.1
[0.5.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.4.0...subagent-v0.5.0
[0.4.0]: https://github.com/Chase-C/pi9/compare/subagent-v0.3.1...subagent-v0.4.0
[0.3.1]: https://github.com/Chase-C/pi9/compare/v0.3.0...subagent-v0.3.1
[0.3.0]: https://github.com/Chase-C/pi9/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Chase-C/pi9/compare/v0.1.1...v0.2.1
