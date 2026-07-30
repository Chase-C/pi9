# @pi9/subagent

Delegate focused work from Pi to context-isolated child conversations. The `subagent` tool provides agent discovery, asynchronous delegation, live steering and inspection, blocking result collection, recursive delegation, cancellation, and explicit cleanup.

![The complete subagent workflow](media/subagent-overview.png)

## Features

- Stable `subagentId` handles across spawn, resume, steer, inspect, cancel, join, and remove.
- Retained child context for follow-up work after a result has been joined.
- Shared recursive scheduling and ownership across the delegation tree.
- Live queued/running progress, recent tools, nested work, and completed answers.
- Ordered batch results with isolated item failures.
- Explicit cleanup through subtree removal.

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
| `inspect` | Return bounded current status, configuration, and progress without waiting. |
| `join` | Wait for and collect a direct child's result. It blocks while active and is idempotent after completion. |
| `remove` | Permanently remove inactive direct-child subtrees. An active descendant rejects removal. |

Only a subagent's direct owner can act on it. The root owns top-level subagents; each subagent owns the children it spawned. Descendant trees shown by `list` are informational and do not grant ancestor control.

Parallel work streams independently:

![Two parallel subagents](media/live-parallel-runs.png)

## Public status and capabilities

Every live-subagent success starts with the same caller-relative block:

```json
{
  "ok": true,
  "subagentId": "quiet-otter",
  "label": "map authentication",
  "agent": "scout",
  "status": "running",
  "availableActions": ["steer", "cancel", "inspect", "join"]
}
```

The public statuses are:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

Finished blocks also include `joined`. Failed blocks include `failure`, whose prose identifies whether execution failed, was interrupted, or was skipped. `availableActions` contains every action currently legal for that caller. It can change between calls, so rejected actions against a live subagent return its current canonical fields for self-correction.

`status` describes execution only. `joined` separately records whether the latest result has been collected. Joining is idempotent and remains available after completion. Resume appears only after a finished result is joined and a reusable session remains.

## Response envelopes

Item-processing actions return:

```json
{
  "action": "spawn",
  "results": [
    {
      "ok": true,
      "subagentId": "quiet-otter",
      "label": "auth map",
      "agent": "scout",
      "status": "queued",
      "availableActions": ["cancel", "inspect", "join"]
    },
    {
      "ok": false,
      "label": "missing helper",
      "error": "Unknown agent: missing."
    }
  ]
}
```

Successful items are flat—there is no `data` wrapper. Targeted failures include `subagentId`; failures against a live subagent also include its current status and capabilities. Failed spawns include the requested label. Items remain in input order and one failure does not prevent valid siblings from proceeding.

Invocation-level failures use `{ "action": "...", "error": "..." }`.

The package entry point exports `CanonicalLiveSubagent`, `CanonicalFinishedSubagent`, `SubagentIdentity`, `SubagentAction`, `SubagentStatus`, and the response-envelope types for typed integrations.

`remove` is the exception because its target is no longer live. A success is `{ "ok": true, "subagentId", "label", "removedIds" }`, where `removedIds` contains the removed subtree. `agents` returns flat `{ "ok": true, ...definition }` items.

## Listing and inspection

`list({ statuses: ["running", "failed"] })` filters direct children with OR semantics. `list({ joined: false })` returns finished direct children whose latest result still needs collection. When `joined` is supplied, active children do not match because they have no finished result.

Each direct child carries the canonical block and a `descendants` tree. Descendant nodes contain only `{ subagentId, label, agent, status }` plus nested descendants. Filters do not alter those informational trees.

Inspection is side-effect-free and bounded. Running results can include phase, elapsed time, requested and effective configuration, recent tools, message snippets, steer receipts, turns, and compactions. Completed output remains exclusive to `join`.

## Join, resume, cancellation, and removal

A join on queued or running work waits for settlement. Concurrent joins all receive the settled result; once any succeeds, `joined` is true. Repeated joins return the same result. A finished subagent must be joined before resume becomes available.

Cancellation waits for SDK cancellation and execution settlement. If an execution does not settle within an internal bound, the runtime detaches it, best-effort kills it, releases scheduler capacity, and records `cancelled`. This means “no longer tracked,” not that external side effects have provably stopped. Cancellation does not join the result; a later join can collect partial diagnostics and unlock resume when context remains reusable.

Removal deletes an inactive direct child and all descendants child-first. Any queued, running, or still-settling member rejects the whole subtree operation.

Recursive delegation uses the same rules:

![Recursive delegation](media/recursive-delegation.png)

## Capacity and UI

Concurrency is shared across the recursive tree. `maxConversations` defaults to `100`; new spawns are rejected at capacity until subagents are removed. Existing subagents can still be inspected, joined, resumed when eligible, or removed.

Settings are stored at `${PI_AGENT_DIR ?? ~/.pi/agent}/subagent/settings.json`. `/subagents` opens the inventory, agent browser, and settings UI. The overlay retains a **Previous runs** section for local history, while ordinary tool responses describe only the current subagent.

The widget defaults to summary mode. Progress mode shows queued/running rows up to the configured limit.

## Notifications and lifecycle events

Completion notifications use the same canonical fields relative to the root caller and include `failure` for failed work. A caller-initiated cancel suppresses that caller's finish notification. Inspecting a finished subagent also suppresses redundant notification; inspecting active work does not. `list` remains pure.

The public lifecycle events are:

- `subagent:queued`
- `subagent:started`
- `subagent:finished`

Each event payload is the canonical live-subagent block. Granular internal outcomes remain private and are used for diagnostics, notification severity, resumability, and historical overlay rendering.

## Breaking migration

There is no compatibility layer for earlier lifecycle, filtering, nesting, or event contracts. Callers must use required labels, the five public statuses, the `joined` flag, caller-relative `availableActions`, direct-child listing, flat result items, and the three lifecycle events documented above.

Private execution history remains runtime-local and supports the overlay's historical view. It is not a provider-facing identity model and is not restored as live work after restart.
