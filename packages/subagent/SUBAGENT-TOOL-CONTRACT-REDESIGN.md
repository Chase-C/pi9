# Subagent Tool Contract Redesign

## Agreed contract

### Canonical live-subagent block

Every successful result concerning a live subagent begins with:

```ts
{
  ok: true;
  subagentId: string;
  label: string;
  agent: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  joined?: boolean; // present when status is completed | failed | cancelled
  availableActions: SubagentAction[];
}
```

- `label` becomes required when spawning.
- Duplicate labels remain allowed; `subagentId` is the unique handle, and `agent` aids disambiguation in mixed swarms.
- `joined` reports whether the finished result has been collected. It is orthogonal to `status`, which remains a pure execution-outcome scalar. Because `join` is idempotent, `availableActions` cannot carry this signal.
- `availableActions` is caller-relative and contains every action currently legal.
- A failed subagent also includes:

```ts
failure: string;
```

Compact surfaces may bound the text with an explicit truncation marker; `join` returns the full explanation.

### Public state model

The public lifecycle enum is removed:

- No `active`
- No `awaiting_join`
- No `resumable`
- No `terminal`
- No public `state` or `canResume`

The scalar `status` describes the subagent's current execution:

| Public status | Internal outcomes |
|---|---|
| `queued` | Waiting for execution |
| `running` | Executing |
| `completed` | Successful completion |
| `failed` | Error, interruption, or skipped execution |
| `cancelled` | Explicit `cancel` action |

Granular internal outcomes remain available for:

- Computing `availableActions`
- Determining resumability
- Diagnostics
- Notification severity
- Full failure messages

Thus two `failed` subagents may have different available actions—for example, one may retain a resumable session while another never created one.

No machine-readable failure discriminant is added. Retry-versus-abandon decisions read from `availableActions`, and the `failure` prose must make the failure category clear on its own—the consumer is an agent. Failure-message templates are pinned by tests so this property cannot silently rot.

### Join semantics

- `join` is explicitly described as **idempotent**.
- Public and internal “acknowledged” terminology is removed.
- Internal state becomes `joined`/`markJoined`.
- A finished subagent must be joined before `resume` becomes available.
- Repeated `join` remains legal and appears in `availableActions`.
- Joining unlocks `resume` only when the retained internal outcome/session permits it.
- `join` on a `queued` or `running` subagent **blocks** until execution settles, then returns the finished canonical block plus output. `join` therefore appears in `availableActions` for running subagents.
- A successful `join` result reports `joined: true`—the join that just completed is included.
- Concurrent join calls (duplicate ids in one invocation, overlapping invocations, internal observers such as the overlay) each block and each receive the settled result; the subagent is `joined` once any of them completes.

These semantics live in this document and in contract tests. The tool prompt spends only one clause on them—e.g. `join: Wait for and collect a subagent's result; blocks while running, idempotent after.` The rest is taught at runtime: the `joined` field in every canonical block carries state passively, and rejected actions return the current canonical block (see Result envelopes), letting the caller self-correct without prompt guidance.

### Cancellation

`cancel` waits until cancellation and execution settlement are complete before returning.

If settlement does not arrive within an internal bound (e.g. a hung tool call or unresponsive provider), cancellation **forcibly abandons** the execution: listeners are detached, the execution is best-effort killed, and the run is marked `cancelled`. The bound is an implementation detail, not contract surface.

Therefore `cancel` always returns a settled subagent, and no public `cancelling` status is needed. A successful cancellation response immediately reports stable follow-up actions.

Tradeoff: an abandoned execution may still be mid-operation (e.g. a shell process writing files) when severed, so `cancelled` means "detached and no longer tracked," not "provably halted."

`cancel` does **not** mark the subagent joined: `join` still collects partial output and remains required before `resume`. However, a caller-initiated cancel suppresses the finish notification for that caller—they already know.

### List filtering

Replace:

```ts
list(scope?, state?)
```

with:

```ts
list(statuses?, joined?)
```

- `statuses` is a non-empty array using the five public status values.
- `joined` is a boolean applying to finished subagents; `list({joined: false})` answers “what do I still need to collect?”
- `scope` is removed. Callers can only act on direct children, so `list` always returns direct children, each carrying a minimal read-only tree of its descendants for context.
- Each descendant tree node is `{subagentId, label, agent, status}`. Descendants carry no `availableActions` because they are not actionable by the caller.
- Filters apply to direct children only; the descendant subtree under each child is informational and unfiltered.

Each listed subagent includes its canonical block, so filtering answers “which subagents have this status?” while `availableActions` answers “what can I do with each one?”

### Runs terminology

Provider-facing and ordinary user-facing surfaces stop exposing execution-history concepts:

- Remove `latestRun`
- Remove `runCount`
- Do not expose run IDs
- Describe current information as belonging to the subagent

The overlay's explicit **Previous runs** historical section remains unchanged conceptually. Internal implementation and persisted data may also retain runs where necessary.

### Result envelopes

Item-processing actions use:

```ts
{
  action: string;
  results: ResultItem[];
}
```

Successful items are flat:

```ts
{
  ok: true;
  // canonical fields and action-specific fields
}
```

Action/item failures are flat:

```ts
{
  ok: false;
  subagentId?: string;
  label?: string;
  agent?: string;
  status?: SubagentStatus;
  joined?: boolean;
  availableActions?: SubagentAction[];
  error: string;
  code?: string;
}
```

- Failed spawns include their requested `label` because no `subagentId` exists.
- Targeted failures include `subagentId`.
- Failures targeting a **live** subagent (e.g. `resume` before join, `steer` after finish) include the current canonical fields. `availableActions` is advertisory and can go stale between calls; embedding the current block makes every race self-healing in one round trip instead of requiring a follow-up `inspect`.
- `code` remains optional; the codes that are emitted are standardized and pinned by tests.
- Invocation-level failures remain:

```ts
{
  action: string | "unknown";
  error: string;
  code?: string;
}
```

### Exceptions

`remove` returns a receipt because the target is no longer live:

```ts
{
  ok: true;
  subagentId: string;
  label: string;
  removedIds: string[];
}
```

`removedIds` covers the removed subtree, including `subagentId` itself.

It does not claim a current `status` or `availableActions`.

`agents` also adopts flat discriminated items:

```ts
{
  action: "agents";
  results: [
    {
      ok: true;
      name: string;
      description?: string;
      // definition fields
    }
  ];
}
```

### Other public surfaces

- Completion notifications use the canonical block relative to the root caller.
- Caller-initiated cancellation suppresses the finish notification for that caller.
- Lifecycle snapshots use the same canonical fields where possible.
- The public event set is `subagent:queued`, `subagent:started`, and `subagent:finished`.
- `subagent:completed` becomes `subagent:finished`, since it covers completed, failed, and cancelled statuses.
- Historical overlay views retain their specialized execution history.

## Implementation architecture

The contract above is implemented through a small set of canonical domain types and explicit boundary projections. Internal types should not be reused merely because their fields happen to overlap; reuse follows shared meaning and ownership.

### Agent configuration

`AgentDefinition` is the discovered markdown definition, including its system prompt and definition defaults. A conversation stores separate configuration concepts:

- `AgentDefinitionSummary` — immutable definition identity shown by inventory and UI surfaces.
- `RequestedExecutionConfig` — the definition defaults after spawn overrides are applied.
- `ExecutionOverrides` — only the caller-supplied model and thinking overrides.
- `EffectiveExecutionConfig` — the model, thinking level, working directory, skills, and tools actually used by the SDK session.

`ConversationSnapshot` exposes these concepts independently. It does not combine definition metadata and requested execution settings into a generic `config` object.

### Conversations and runs

`Conversation` owns one retained SDK session and an append-only sequence of `Run` instances. `RunState` is the authoritative mutable execution state:

- `queued`, with its creation time supplied by the run;
- `running`, with the bound SDK session and start time;
- `done`, with the internal outcome, timestamps, output, and error directly on the state.

`RunSnapshot` is the serializable view used outside the mutable execution holder. It deliberately omits the SDK session while preserving detailed internal outcomes. `RunRef` is the canonical `{ conversationId, runId }` identity used by runtime records, callers, scheduler receipts, and join bindings.

Detailed outcomes (`completed`, `error`, `aborted`, `interrupted`, and `skipped`) remain internal domain information. They project to the five public `SubagentStatus` values only at the public contract boundary.

### Public subagent projection

`projectLiveSubagent` is the sole owner of the caller-relative public lifecycle block. `CanonicalLiveSubagent` is a discriminated union:

- queued and running variants cannot contain `joined` or `failure`;
- completed and cancelled variants require `joined` and cannot contain `failure`;
- failed variants require both `joined` and `failure`.

The runtime supplies ownership, resumability, and subtree-removability facts to the projector. Callers consume `availableActions` rather than reconstructing those policies.

Action failures remain action-local. A failure against a retained subagent combines the current canonical fields with `ok: false` and `error`; unresolved targets and pre-allocation spawn failures carry only the identities that actually exist. There is no all-optional universal failure interface.

### Tool input and response boundaries

TypeBox schemas are the source of truth for spawn, resume, and steer input fields. Runtime request types are derived from those schemas and add only internal discriminators and branded subagent IDs. The manual parser remains responsible for ordered item failures and contract-specific error messages.

Every item-processing action produces a `SubagentResultsEnvelope`; invocation failures produce a `SubagentErrorEnvelope`. The exact response object serialized into tool content is also stored in `SubagentToolDetails.response`.

Renderers consume that canonical response directly for agents, list, cancel, inspect, and remove. Only two associated views remain:

- `DispatchRenderView` carries prompts and acceptance context omitted from provider responses.
- `JoinRenderView` carries live nested activity, historical joins, and background work omitted from provider responses.

These views are presentation data, not alternate sources of public subagent state.

### Runtime action outcomes

Runtime methods return the smallest receipt needed by their callers:

- cancellation returns a `RunRef`;
- steering adds a `SteerReceipt` to a `RunRef`;
- inspection returns the run snapshot with its conversation identity;
- removal returns ordered `RemoveOutcome` items, one per unique requested target.

Removal computes subtree effects once and returns target-relative receipts. The tool layer preserves malformed-target positions while consuming valid runtime outcomes in order; it does not reconstruct results by searching aggregate arrays.

### Notifications, events, and persistence

Lifecycle events use the root- or owner-relative canonical subagent projection unchanged.

`CompletionNotification` is the serializable form of `CanonicalFinishedSubagent` plus run correlation and timing metadata. Persisted custom messages are still validated defensively because they may come from older sessions or untyped storage. Failed persisted notifications require `failure`; completed and cancelled notifications reject it.

The version 3 `subagent-run-index` entry remains a separate persistence record. It stores private execution-history metadata and is not treated as a live subagent representation.

### Contract invariants

The implementation and tests enforce these boundaries:

1. Public tool JSON, lifecycle events, notifications, rendered text, and version 3 metadata are stable contracts.
2. Mutable sessions never appear in snapshots or serialized payloads.
3. Internal run outcomes are projected to public statuses in one place.
4. Finished-state fields are enforced by discriminated types, not caller convention.
5. Tool response and renderer data share one response object.
6. Specialized views cannot replace or contradict canonical public fields.
7. Ordered batch processing isolates item failures without reordering successful siblings.
8. Direct ownership is required for actions; descendant trees remain informational.
