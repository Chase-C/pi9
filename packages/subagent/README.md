# @pi9/subagent

Delegate focused work from Pi to context-isolated child conversations. The single `subagent` tool provides agent discovery, side-effect-free inventory, asynchronous runs, blocking retrieval, explicit cleanup, recursive delegation, and live progress.

![A subagent run with nested children rendering live progress, tool calls, and per-child counters](media/subagent-overview.png)

## Install

```bash
pi install npm:@pi9/subagent
```

## Quick start

Define an agent in `.pi/agents/scout.md`:

```markdown
---
name: scout
description: Read-only codebase reconnaissance
model: anthropic/claude-sonnet-4
tools: read, bash
---

Inspect the repository and return concise, evidence-backed findings.
```

Start a run:

```ts
subagent({
  action: "run",
  tasks: [{ agent: "scout", label: "auth map", prompt: "Find the auth entry points." }]
})
```

`run` is always asynchronous. It returns immediately with two process-local identifiers for each accepted task:

- `conversationId`, a readable adjective-noun identifier such as `quiet-otter`
- `runId`, a readable verb-adverb identifier such as `search-boldly`

Wait for that exact run and retrieve its output with `join`:

```ts
subagent({ action: "join", runIds: ["search-boldly"] })
```

Continue the conversation after it becomes resumable:

```ts
subagent({
  action: "run",
  tasks: [{ conversationId: "quiet-otter", prompt: "Turn those findings into a plan." }]
})
```

## Define agents

Agent markdown is discovered from the user `${PI_AGENT_DIR ?? ~/.pi/agent}/agents` directory and the nearest project `.pi/agents`. Project definitions override same-named user definitions by default.

| Frontmatter | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Runtime agent name. |
| `description` | yes | Non-blank discovery summary. |
| `model` | no | `provider/model` or an unambiguous model id. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | no | Comma-separated allowlist; include `subagent` for recursive delegation. |
| `skills` | no | Comma-separated default skills. A spawn-task value replaces this list. |

The body becomes the child system prompt. Spawn tasks require `agent` and `prompt`; `label` is optional, and may override supported execution options such as model, thinking, working directory, and skills. Follow-up tasks identify a conversation and provide a prompt; the conversation's agent and execution context remain fixed.

## Tool actions

| Action | Behavior |
| --- | --- |
| `agents` | Discover agent definitions and their resolved defaults. |
| `list` | Return a lightweight inventory of conversations and runs without run output. It is pure: it acknowledges nothing and changes no lifecycle state. |
| `run` | Start one or more tasks asynchronously, returning a `conversationId` and `runId` for each accepted task. |
| `join` | Block until each specified exact run settles, then return that run's output or error. There is no timeout. Cancelling `join` stops only the wait; it does not stop the underlying run. |
| `remove` | Explicitly batch cleanup for the specified conversations, stopping their active work if necessary and removing their runs and accumulated context. |

A run belongs to one conversation. Spawning creates both; a follow-up creates another run in an existing conversation. Every conversation remains available in the runtime inventory until explicitly removed, including after successful, failed, or interrupted work.

`canResume` becomes true only after a completed run or an interrupted run that preserved its conversation context. It remains false while work is queued or active, and after failures or interruptions that did not preserve context.

`join` is keyed by `runId`, not merely by conversation, so a caller always receives the requested run even when that conversation has newer work. Use `remove` with conversation identifiers when the whole conversation is no longer needed.

## Capacity and concurrency

Concurrency is shared across the entire recursive delegation tree. `maxConversations` defaults to `100`. Once that many conversations are present, new spawns are rejected until one or more conversations are removed; existing conversations can still be inspected, joined, or cleaned up.

Settings are stored at `${PI_AGENT_DIR ?? ~/.pi/agent}/subagent/settings.json`. Common runtime and display controls are also available through `/subagents settings`.

## Notifications, UI, and lifecycle

Completion notifications concern settled runs that have not yet been acknowledged. Listing inventory does not acknowledge them. Joining a run acknowledges that exact run; cleanup also clears notifications associated with the removed conversations.

`/subagents` opens the conversation, agent, and settings UI. It provides live status and progress, access to completed output, follow-up prompts when `canResume` is true, and explicit conversation cleanup.

The package emits lifecycle updates for queued, started, and completed work. Identifiers, run records, and child conversation context are runtime-local only. They are not restored after a process restart or extension reload.

## Major-version migration

There is no compatibility layer for the previous lifecycle API.

| Previous term or behavior | New contract |
| --- | --- |
| `foreground` / `background` dispatch | `run` always starts asynchronously; use `join` when blocking retrieval is needed. |
| `results` action | `join` waits for and retrieves an exact run. |
| `sessionId` | Use `conversationId` for conversation lifecycle and `runId` for exact-run retrieval. |
| `retainConversation` | Every conversation remains in the runtime until explicit `remove`. |

## Architecture

- `src/domain/` owns agents, conversations, runs, lifecycle state, and capabilities.
- `src/runtime/` owns orchestration, queues, limits, notifications, and child execution.
- `src/tool/` owns action handlers and child tool injection.
- `src/command/`, `src/ui/`, and `src/view/` own the overlay, persistent display, and rendering.
