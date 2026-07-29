# @pi9/subagent

Delegate focused work from Pi to context-isolated child conversations. The single `subagent` tool provides agent discovery, side-effect-free inventory and inspection, asynchronous runs, live steering, blocking retrieval, explicit cleanup, recursive delegation, and live progress.

![The complete subagent workflow: discover agents, start and list parallel runs, join their results, and remove their conversations](media/subagent-overview.png)

## Feature overview

- **Retained conversations** preserve child context for follow-up runs until the parent explicitly removes the conversation.
- **Asynchronous runs and exact joins** let the parent continue working after spawning or resuming work, then wait for and retrieve specific runs by ID.
- **Bounded inspection, steering, and cancellation** let the parent check progress, redirect an active run, or stop it while retaining its outcome.
- **Recursive delegation** lets subagents run, inspect, steer, cancel, and join their own descendants under tree-wide ownership and concurrency rules.
- **Live progress** shows queued and running work, recent tool activity, recursive children, and completed answers in tool and widget views.
- **Unified conversation management** provides live status, completed output, follow-up prompts, agent discovery, cleanup, and settings through `/subagents`.
- **Focused tool actions** separate agent discovery, side-effect-free inventory, task execution, blocking retrieval, and cleanup without adding multiple tools to the parent context.
- **Minimal tool prompt size** keeps delegation overhead low and reduces context bloat in the parent conversation.

## Install

```bash
pi install npm:@pi9/subagent
```

## Define agents

Agent markdown is discovered from the user `${PI_AGENT_DIR ?? ~/.pi/agent}/agents` directory and the nearest project `.pi/agents`. Project definitions override same-named user definitions by default.

For example, `.pi/agents/scout.md` defines a project-local read-only agent:

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
| `description` | yes | Non-blank discovery summary. |
| `model` | no | `provider/model` or an unambiguous model id. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | no | Comma-separated allowlist; include `subagent` for recursive delegation. |
| `skills` | no | Comma-separated default skills. A spawn-task value replaces this list. |

The body becomes the child system prompt. `spawn` accepts a `spawns` array whose entries require `agent` and `prompt`; `label` is optional, and entries may override supported execution options such as model, thinking, working directory, and skills. A model requested by either the task or agent definition must resolve; an unknown or malformed value fails that task instead of falling back. When neither specifies a model, the child inherits the parent's model. An explicit task `cwd` is resolved relative to the parent's working directory and must identify an existing directory. `resume` accepts a `resumes` array whose entries identify a conversation and create another run with the supplied prompt; the conversation's agent and execution context remain fixed. `messages` entries identify an active run and queue the supplied `message` through Pi's steering boundary without creating another run. `cancel` targets exact queued or running runs by `runId`.

## Tool actions

| Action | Behavior |
| --- | --- |
| `agents` | Discover agent definitions and their resolved defaults. |
| `list` | Return immediate child conversations by default, or the caller's full owned subtree with `scope: "descendants"`, optionally filtered by conversation `state`. Every included conversation retains its complete output-free run history. It is pure: it acknowledges nothing and changes no lifecycle state. |
| `spawn` | Start the ordered `spawns` batch asynchronously. Each accepted task creates a conversation and its first run. |
| `resume` | Start the ordered `resumes` batch asynchronously. Each accepted task creates another run in an existing conversation. |
| `steer` | Send `messages` to existing running runs and return ordered lifecycle receipts after Pi accepts each message. |
| `cancel` | Abort exact queued or running runs while retaining their conversations and aborted outcomes for `inspect` and `join`. Malformed, unknown, terminal, or unauthorized targets become ordered per-target errors. |
| `inspect` | Return bounded status, conversation ownership and spawn provenance, requested overrides, effective execution configuration, running phase, current message, recent tool activity, steer receipts, and terminal error diagnostics for exact runs without waiting or acknowledging them. Invalid targets become ordered per-target errors. Terminal output is omitted. |
| `join` | Block until every valid explicitly requested exact run settles, then return and acknowledge those runs. Malformed, unknown, or unauthorized targets become ordered per-target errors without hiding valid sibling outcomes. There is no timeout. Cancelling `join` stops only the wait; it does not stop the underlying runs. |
| `remove` | Permanently delete terminal conversation subtrees and all their run records. Any active descendant rejects deletion of the entire subtree. |

Parallel runs stream their current status and recent tool activity independently:

![Two parallel subagent runs with one completed and one still exploring the codebase](media/live-parallel-runs.png)

Every processed invocation returns `{ action, results }`; a command-level failure returns `{ action, error }`. Provider-level schema violations can reject a tool call before execution, and settings-preparation failures can prevent an envelope from being produced.

`agents` and `list` return their discovered entities directly in `results`. For `spawn`, `resume`, `steer`, `cancel`, `inspect`, `join`, and `remove`, every requested item produces one ordered result: `{ ok: true, data }` when that item was processed or `{ ok: false, error }` when it failed. Item-level failures do not prevent valid siblings from proceeding. Streaming `join` updates use the same envelope as its final result.

Invalid outer invocations—including a missing or unknown action, absent or empty inputs, and batch-limit violations—return a command-level `error`. Malformed target IDs remain ordered item failures rather than rejecting valid siblings.

Successful steer outcomes include a `steer` receipt with a per-run numeric ID, state, and timestamps. Receipt states advance from `queued` when Pi accepts the message, to `delivered` when the steering user message enters the child turn, and to `processed` when the assistant begins responding with that message in context. `processed` does not mean the requested work succeeded. A run that terminates before a queued or delivered steer is processed marks that receipt `discarded`.

For example, a `spawn` call returns one result for each entry in `spawns`:

```json
{
  "action": "spawn",
  "results": [
    {
      "ok": true,
      "data": { "label": "auth map", "conversationId": "quiet-otter", "runId": "search-boldly" }
    },
    { "ok": false, "error": "Unknown agent: missing." }
  ]
}
```

Rejected spawn tasks receive no allocated `conversationId` or `runId`; failed resume and steer items may echo the requested target identity. Accepted spawn and resume tasks enter the run lifecycle; accepted steer messages return the existing target identities and do not create lifecycle records.

A run belongs to one conversation. Spawning creates both; a follow-up creates another run in an existing conversation. Every conversation remains available in the runtime inventory until explicitly removed, including after successful, failed, or interrupted work.

`canResume` becomes true after a completed, interrupted, or cancelled run when the conversation session remains available and all execution cleanup has settled. It remains false while work is queued, active, or still stopping, and after failures that did not preserve context.

Conversations form the stable ownership tree. A spawned conversation records its immutable `parentConversationId` and the exact `spawnedByRunId` that created it. Resuming adds another run to that same conversation without moving it or changing which descendants it owns. Runs remain exact execution records, so `inspect`, steer messages, `cancel`, and `join` continue to target `runId`; authorization is determined by the target run's conversation. A child may list and operate only on descendant conversations, while the root Pi session owns the complete forest. Agent definitions remain globally discoverable.

`list` defaults to immediate children. Pass `scope: "descendants"` for the complete owned subtree; at the root this is the global runtime inventory. Its optional `state` array filters conversations with OR semantics: `active` means queued, running, or still stopping; `resumable` means settled with preserved context; and `terminal` means settled without resumable context. Listed conversations expose their state, parent, spawn provenance, depth, and complete run histories, while runs remain parentless episodes. Inspection is pure and bounded; malformed, duplicate, unknown, or unauthorized targets return ordered per-target errors without hiding valid siblings. A running snapshot includes `phase`, requested overrides, effective configuration, recent activity, and steer receipts. Terminal output remains exclusive to `join`.

Only explicitly joined descendants block the caller. Unjoined descendants continue independently when their spawning run finishes, but remain owned by their stable parent conversation. Nested answers are returned directly to the child that joined them, while ancestor rendering retains lifecycle and identity context without copying target answers. Nested join-attempt history is runtime-local and is not restored after restart or extension reload.

![A technical-lead subagent joining two nested investigations with live tool activity](media/recursive-delegation.png)

Cancellation settles a queued or running run as `aborted` and preserves its conversation and exact run record, so the caller can inspect or join the outcome. Queued runs are removed before execution. Once SDK abortion and execution cleanup have both settled, a preserved conversation becomes resumable. Removal collects the requested conversation and all descendants as one subtree. If any member is queued, running, or still stopping, the whole subtree is retained and the active run IDs are reported. Otherwise every conversation and run in the subtree is permanently deleted in child-first order; no reparenting or orphan state exists.

## Capacity and concurrency

Concurrency is shared across the entire recursive delegation tree. `maxConversations` defaults to `100`. Once that many conversations are present, new spawns are rejected until one or more conversations are removed; existing conversations can still be inspected, joined, or cleaned up.

Settings are stored at `${PI_AGENT_DIR ?? ~/.pi/agent}/subagent/settings.json`. The widget defaults to **summary** mode, a one-line count of running, queued, and all retained conversations; **progress** mode instead shows active queued/running rows and respects the `Progress rows` limit in `/subagents settings`. Retained conversations remain counted after they settle until explicit `remove`. Existing `widgetLayout: "columns"` or `"stacked"` settings migrate to progress mode, while `"auto"` (or no legacy value) becomes summary; saved settings use `widgetMode`.

## Notifications, UI, and lifecycle

Completion notifications alert the parent to terminal outcomes it has not otherwise observed. Human-facing completion status uses Pi's notification UI; the model-facing custom message is hidden and contains only compact `<subagent-notification>` run metadata. Immediately before each model request, a `context` handler projects that message from live runtime state and omits runs that have since been observed, acknowledged, claimed by inspect/cancel/join, bound by an active join, or removed. This projection modifies only Pi's outgoing context copy, never stored session history. A terminal `inspect` or successful `cancel` suppresses a later notification for that run without retrieving or acknowledging its outcome; inspecting an active run does not suppress notification if it settles later. `list` remains pure and does not suppress notifications. Joining a run retrieves and acknowledges that exact outcome, while cleanup clears notifications associated with removed conversations. Delivery waits through a fixed grace window and tool-call-scoped inspect, cancel, or join claims shared across root and recursive agents, so immediate lifecycle handling can finish before notifications are coalesced and sent.

`/subagents` opens the conversation, agent, and settings UI. It provides live status and progress, cancellation of queued or running work, access to completed output, follow-up prompts when `canResume` is true, and permanent terminal-conversation cleanup.

The package emits lifecycle updates for queued, started, and completed work. Nested join changes emit `subagent:updated` with `kind: "nestedJoin"` and the owner conversation snapshot; they do not create additional queued, started, or completed milestones. Identifiers, run records, child conversation context, and nested join-attempt history are runtime-local only. They are not restored after a process restart or extension reload.

Spawn and resume tasks remain asynchronous regardless of recursive delegation. Steer messages return after Pi accepts the message; they do not wait for the target to act on it. Cancel waits for in-flight steering and SDK abortion to finish after terminalizing the run. These semantics do not change the scope or behavior of `/subagents` or its widget.

## Major-version migration

There is no compatibility layer for the previous lifecycle API.

| Previous term or behavior | New contract |
| --- | --- |
| `dispatch` or `run` action | Use `spawn`, `resume`, or `steer`; there is no compatibility alias. |
| `foreground` / `background` dispatch | Spawn and resume tasks always start asynchronously; use `join` when blocking retrieval is needed. |
| `results` action | `join` waits for and retrieves an exact run. |
| `sessionId` | Use `conversationId` for conversation lifecycle and `runId` for exact-run retrieval. |
| `retainConversation` | Every conversation remains in the runtime until explicit `remove`. |
| `widgetLayout` | Use `widgetMode`: legacy `columns`/`stacked` becomes `progress`; `auto` becomes the default `summary`. |

## Architecture

- `src/agents.ts` owns agent definitions, discovery, parsing, and requested configuration.
- `src/conversation.ts` and `src/activity.ts` own persistent conversations, exact runs, lifecycle state, and live SDK activity.
- `src/runtime.ts` owns the conversation catalog, cancellation, joining, scheduling, queue limits, and exact run records; `src/execute.ts` owns child SDK session execution.
- `src/schema.ts` and `src/tool.ts` own provider-facing validation and tool actions.
- `src/notifications.ts`, `src/widget.ts`, and `src/command/` own the three user-facing presentation surfaces.
- `src/settings.ts`, `src/identifiers.ts`, and `src/index.ts` own configuration, runtime-local identifiers, and Pi extension composition respectively.
