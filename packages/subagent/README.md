# @pi9/subagent

Delegate focused work from Pi to context-isolated child conversations. The `subagent` tool provides agent discovery, asynchronous delegation, live steering and inspection, blocking result collection, recursive delegation, cancellation, and explicit cleanup.

![The complete subagent workflow](media/subagent-overview.png)

## Feature overview

- **Parallel, non-blocking delegation** lets Pi hand off focused tasks and keep working while they run.
- **Stateful follow-ups** preserve each subagent's context so completed work can continue without starting over.
- **Live visibility and control** provide progress, recent activity, steering, and cancellation while work is running.
- **Recursive delegation** lets subagents coordinate their own children under shared ownership and concurrency limits.
- **Context-efficient tooling** uses a compact, purpose-built schema for precise delegation and lifecycle control with minimal context overhead.
- **Built-in management** brings status, results, follow-ups, cleanup, and settings together in `/subagents`.

## Install

```bash
pi install npm:@pi9/subagent
```

## Define agents

Agent markdown is discovered from `${PI_AGENT_DIR ?? ~/.pi/agent}/agents` and the nearest project `.pi/agents`. Project definitions override same-named user definitions.

```markdown
---
name: scout
description: Read-only codebase reconnaissance
model: anthropic/claude-sonnet-4
tools: read, bash
---

Inspect the repository and return concise, evidence-backed findings.
```

| Frontmatter | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Runtime agent name. |
| `description` | yes | Nonblank discovery summary. |
| `model` | no | `provider/model` or an unambiguous model ID. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | no | Comma-separated allowlist; include `subagent` for recursive delegation. |
| `skills` | no | Comma-separated default skills. A spawn value replaces this list. |

The body becomes the child system prompt. Every spawn requires `agent`, `prompt`, and a nonblank `label`. Duplicate labels are allowed; `subagentId` remains the unique handle. Entries may override model, thinking, working directory, and skills.

## Tool actions

| Action | Behavior |
| --- | --- |
| `agents` | List available agent definitions. |
| `list` | List direct children, with a minimal read-only descendant tree. Filter direct children with `statuses` and/or `joined`. |
| `spawn` | Start an ordered batch of labelled subagents asynchronously. |
| `resume` | Continue a joined subagent that retained a resumable session. |
| `steer` | Send messages to running direct children. |
| `cancel` | Settle active direct children as cancelled while retaining context and partial results. |
| `inspect` | Return bounded current status, configuration, and progress for any descendant without waiting. |
| `join` | Wait for and collect a direct child's result. It blocks while active and is idempotent after completion. |
| `remove` | Permanently remove inactive direct-child subtrees. An active descendant rejects removal. |

Live-subagent results include `actionHints`: snapshot-derived suggestions that may become stale as the subagent changes state.

A caller can inspect any subagent in its descendant tree, but can mutate only its direct children. Top-level subagents belong to the main Pi session, while recursively delegated work remains under its immediate parent.

## How subagents work

Subagents are context-isolated Pi conversations created from reusable agent definitions. They share the working filesystem with the main session, but keep their own prompts, tools, and conversation history.

### Parallel delegation

Delegated work starts asynchronously, allowing Pi to launch several focused tasks and continue working while they run. Each task streams its own progress and recent activity. When a result is needed, Pi joins that specific subagent and waits for its current work to finish.

![Two parallel subagents](media/live-parallel-runs.png)

### Follow-up work

A subagent keeps the same identity and conversation context after finishing. Once its result has been joined, Pi can resume it with a follow-up prompt instead of explaining the task again or creating a replacement. Follow-ups appear as successive generations in the subagent's history.

### Live progress and control

Running work can be inspected without interrupting it. Pi can also steer a subagent with an additional message or cancel work that is no longer needed. Cancellation retains any reusable context and partial diagnostics, but cannot undo external side effects that have already occurred.

### Recursive delegation

Subagents can delegate work to children of their own. Ownership follows the delegation tree, and concurrency is shared across the entire tree so nested work follows the same limits as top-level work.

![Recursive delegation](media/recursive-delegation.png)

### Results and cleanup

Joining collects a finished result and is safe to repeat. Removal is a separate, explicit step that permanently deletes an inactive subagent and all of its descendants. If any work in the subtree is still active, removal is rejected until that work finishes or is cancelled.

## Capacity and UI

Concurrency is shared across the recursive tree. `maxConversations` defaults to `100`; new spawns are rejected at capacity until subagents are removed. Existing subagents can still be inspected, joined, resumed when eligible, or removed.

Settings are stored at `${PI_AGENT_DIR ?? ~/.pi/agent}/subagent/settings.json`. `/subagents` opens the inventory, agent browser, and settings UI. The overlay retains a **Previous runs** section, while `inspect` exposes prior-generation history without outputs or internal run IDs.

The widget defaults to summary mode. Progress mode shows queued/running rows up to the configured limit.

## Notifications

Pi notifies you when delegated work finishes unless the result has already been observed or collected. Cancelling work also suppresses a redundant completion notification. Listing subagents does not acknowledge their results.
