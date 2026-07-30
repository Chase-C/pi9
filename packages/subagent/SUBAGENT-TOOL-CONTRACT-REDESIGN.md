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

## Implementation plan

### Phase 1: Establish the canonical domain projection

1. Define the five-value public `SubagentStatus`.
2. Retain granular internal execution outcomes.
3. Add one projection that maps internal execution state to public status.
4. Add a caller-relative `availableActions` computation.
5. Add a single canonical live-subagent projection used by all public surfaces, including `agent` and (for finished subagents) `joined`.
6. Add bounded/full failure-message projection modes.

**Verification**

- Table-driven tests for every internal state/outcome.
- Tests for joined versus unjoined results.
- Tests for root, direct-owner, and descendant callers.
- Tests for inactive roots with active descendants affecting `remove`.
- Assert every advertised action succeeds absent a race.

### Phase 2: Replace lifecycle and acknowledgment concepts

1. Remove the public lifecycle enum and `canResume`.
2. Replace runtime lifecycle checks with explicit internal predicates:
   - Active execution
   - Finished result
   - Joined result
   - Retained resumable session
   - Removable subtree
3. Rename internal `acknowledged` fields and methods to `joined`/`markJoined`.
4. Update notification suppression and join bindings to use joined terminology.
5. Ensure `resume` requires the latest result to have been joined.
6. Implement bounded cancel settlement with forced abandonment: on internal timeout, detach listeners, best-effort kill the execution, and mark the run `cancelled`.
7. Verify persisted session state loads cleanly across the `acknowledged` → `joined` rename, or migrate it.

**Verification**

- Resume rejected before join.
- Resume allowed after join when internally resumable.
- Non-resumable failures remain non-resumable after join.
- Repeated joins remain successful.
- Join after cancel collects partial output and unlocks `resume` when internally resumable.
- Notification behavior does not regress.
- Cancel of a wedged execution settles via abandonment and returns `cancelled`.

### Phase 3: Normalize tool response contracts

1. Introduce shared success and failure item constructors; failures targeting a live subagent embed the current canonical fields.
2. Flatten `{ok:true,data:{...}}` into `{ok:true,...}`.
3. Make every successful live-subagent result begin with the canonical fields.
4. Update action-specific payloads:
   - `list`: canonical block per direct child plus minimal descendant tree
   - `spawn`: canonical block
   - `resume`: canonical block
   - `steer`: canonical block plus steer receipt
   - `cancel`: canonical block
   - `inspect`: canonical block plus progress/config diagnostics
   - `join`: canonical block plus full output/failure and join history
   - `remove`: removal receipt
   - `agents`: flat discriminated definitions
5. Preserve item order and isolated failures.
6. Include labels in pre-allocation spawn failures.

**Verification**

- Contract tests covering every action.
- Shared assertions enforcing canonical field presence and ordering.
- Mixed success/failure batch tests.
- Invocation-level error tests.
- Ensure action-specific fields cannot replace or contradict canonical fields.
- Rejected actions on live subagents carry current `status` and `availableActions`.
- Failure-message templates are pinned so each failure category stays identifiable from prose.

### Phase 4: Update schema and status filtering

1. Make `spawn.label` required and nonblank.
2. Replace `list.state` with `list.statuses`, add optional `list.joined`, and remove `list.scope`.
3. Validate only the five public statuses.
4. Remove lifecycle-state exports from the provider contract.
5. Update descriptions and prompt guidance:
   - Describe `join` in one clause: waits for and collects the result; blocks while running, idempotent after.
   - Say subagents must be joined before resuming.
   - Keep the prompt minimal otherwise; the `joined` field and canonical-block failures teach the rest at runtime.
   - Remove all acknowledgment language.
   - Remove run-oriented language.

**Verification**

- Schema tests for required labels.
- Duplicate labels accepted.
- Status filters support one or several values.
- `joined` filter selects unjoined finished subagents.
- Legacy `state` and `scope` rejected as a clean breaking change.
- Tool-description tests pin the new terminology.

### Phase 5: Update renderers and overlay

1. Render canonical statuses consistently across tool rows.
2. Render `failed` with the projected failure explanation.
3. Render available actions where useful without making collapsed output noisy.
4. Remove `latestRun` and `runCount` assumptions from list rendering.
5. Render the minimal descendant tree under each direct child in list output.
6. Preserve the overlay's **Previous runs** section.
7. Update current-subagent overlay controls to derive from canonical capabilities where appropriate.

**Verification**

- Collapsed and expanded snapshots for all statuses.
- Overlay history tests remain intact.
- No ordinary tool rendering mentions run IDs or latest runs.
- Action hints match `availableActions`.

### Phase 6: Standardize notifications and events

1. Project completion notifications through the root-relative canonical projector.
2. Include `failure` for failed notifications.
3. Rename `subagent:completed` to `subagent:finished`.
4. Update lifecycle snapshots to canonical fields.
5. Preserve granular internal outcomes for severity decisions.
6. Keep persisted execution-history internals private.

**Verification**

- Notification payload and rendering tests for completed, failed, and cancelled.
- Caller-initiated cancel produces no finish notification for that caller.
- Event tests for queued, started, and finished transitions.
- Root-relative capability tests.
- No acknowledgment or public run terminology remains.

### Phase 7: Regression and consistency enforcement

1. Add a contract test that enumerates every action.
2. Assert every item-processing response uses `{action,results}`.
3. Assert all successful live-subagent items contain exactly the required canonical base.
4. Assert failures use `error`, while failed subagents use `failure`.
5. Search source, tests, README, changelog, and rendered copy for prohibited terms:
   - Public `terminal`
   - Public `awaiting_join`
   - Public `resumable`
   - Public `state` and `canResume`
   - Public `scope`
   - `acknowledged`
   - Provider-facing `latestRun`
   - Provider-facing `runCount`
6. Run typecheck and the complete subagent test suite.
7. Repeat the hands-on lifecycle exercise against the revised tool.

This should be implemented as one intentional breaking contract change rather than a compatibility layer, because retaining aliases would recreate the vocabulary ambiguity we are removing.
