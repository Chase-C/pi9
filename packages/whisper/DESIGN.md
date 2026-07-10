# Whisper Pi Integration Design

`@pi9/whisper` is a pi package that installs a single extension. The extension gives local pi sessions stable process-lifetime ids plus human-readable names, publishes them in a per-user registry, and lets agents or users send messages to another local session by id.

This document covers two contracts:

1. The **pi-facing integration surface**: package resources, flags, commands, tools, lifecycle events, UI, and session state.
2. The **IPC internals**: registry records, liveness, transport, and hierarchy metadata.

The pi-facing contract should remain stable even if the IPC transport changes.

## Goals

- **Pi-native**: install as a pi package and expose ordinary pi tools, flags, UI status, and lifecycle handling.
- **Lightweight**: no daemon, no native dependencies, no external service.
- **Cross-platform**: macOS, Linux, Windows, using Node built-ins.
- **Peer-to-peer**: agents talk directly. The registry is discovery only, not a broker hop.
- **Hierarchy-aware**: agents spawned as children or cohorts are discoverable by lineage, not just by name.
- **Debuggable**: the registry is plain JSON files.

## Non-Goals

- Cross-machine messaging.
- Persistent message queues or durable delivery.
- Pub/sub or broadcast beyond filtered registry queries.
- Routing messages through a broker or through the parent.
- Transactional consistency across the registry.
- A separate pi skill, prompt template, theme, or long-running daemon.

## Pi Package Integration

The package manifest declares one pi resource:

```json
{
  "pi": {
    "extensions": ["./dist/index.js"],
    "skills": [],
    "prompts": []
  }
}
```

When installed with `pi install ...`, listed in settings, or loaded with `pi -e ./dist/index.js`, pi loads the default extension export. There are no bundled skills or prompt templates; all behavior comes from the extension registrations below.

### Startup Configuration

| Surface | Name | Purpose |
|---|---|---|
| Pi flag | `--whisper-name <name>` | Sets the agent's initial Whisper name. Registered with `pi.registerFlag("whisper-name")`. |
| Environment | `PI_WHISPER_NAME` | Alternative startup name when no flag is provided. |
| Environment | `PI_WHISPER_DIR` | Overrides the discovery directory. Defaults to `~/.pi/whisper`. |

Name validation is intentionally narrow: 1-64 characters, letters, numbers, `.`, `_`, and `-`.

Startup name precedence:

1. `--whisper-name`
2. `PI_WHISPER_NAME`
3. Fallback `pi-<pid>`

### Installed Agent Tool

The extension installs exactly one agent tool with `pi.registerTool()`:

| Tool | Parameters | Behavior |
|---|---|---|
| `whisper` | A `Type.Object` with an `action` enum and optional action-specific fields | Lists peers, sends one-way messages, performs request/response asks, replies to pending asks, and (optionally) inspects or waits on the inbox. Inbound `send` and `ask` envelopes are pushed into the receiver's conversation by injection; `wait` and `pending` are pull-side helpers, not required. |

A single tool keeps the model-facing surface compact and makes tool choice obvious: use `whisper` for all local agent-to-agent coordination.

Use a plain object schema rather than a `Type.Union`: `Type.Union`/`Type.Literal` is not compatible with every provider, notably Google's API. Keep the schema provider-friendly by using `Type.String()` fields whose descriptions list the accepted values; `execute()` performs strict validation and throws a clear error for unknown actions, unknown filters, or missing action-specific fields.

Target parameter shape:

```ts
const whisperParams = Type.Object({
  action: Type.String({
    description: "Whisper operation to perform. One of: me, list, update, send, ask, wait, pending, reply.",
  }),
  filter: Type.Optional(Type.String({
    description: "For action='list'. One of: all, parent, siblings, children, descendants. Defaults to all.",
  })),
  to: Type.Optional(Type.String({
    description: "For action='send' and action='ask'. Agent id returned by whisper({ action: 'list' }).",
  })),
  message: Type.Optional(Type.String({
    description: "For action='send', action='ask', and action='reply'.",
  })),
  description: Type.Optional(Type.String({
    description: "For action='update'. Short (1 sentence) description of what this agent is currently working on. Empty string clears it.",
  })),
  requestId: Type.Optional(Type.String({
    description: "For action='reply'. Request id from the injected whisper-ask message or from whisper({ action: 'pending' }).",
  })),
  timeoutMs: Type.Optional(Type.Number({
    description: "For action='ask' and action='wait'. Optional timeout in milliseconds.",
  })),
  urgency: Type.Optional(Type.String({
    description: "For action='send' and action='ask'. One of: interrupt, soon, later. Controls how the receiver sees the message: 'interrupt' delivers between tool calls in the current turn, 'soon' delivers when the receiver would otherwise idle, 'later' queues until the receiver's next user prompt. Defaults to 'interrupt' for ask and 'soon' for send.",
  })),
});
```

Actions:

| Action | Behavior |
|---|---|
| `me` | Returns this agent's own id, name, lineage fields, and registry record. Useful before introducing yourself or debugging identity. |
| `list` | Returns active agents. `filter` defaults to `all`; hierarchy filters require lineage fields and return an empty list when unavailable. |
| `update` | Updates mutable fields in this agent's registry record. Initially only `description` is mutable. |
| `send` | Non-blocking one-way notification. Returns after the target accepts the message; the receiver sees it as an injected `whisper-send` message at the urgency the sender chose (default `soon`). |
| `ask` | Request/response message. The receiver sees it as an injected `whisper-ask` message at the urgency the sender chose (default `interrupt`). Blocks until the target replies, the caller's tool call is aborted, the target disconnects, or `timeoutMs` expires. |
| `wait` | Blocks until this agent has an inbound `send` or `ask` envelope. Returns queued messages immediately before waiting. Optional; inbound messages are also pushed via injection. |
| `pending` | Returns inbound asks that have been delivered to this agent but not yet answered. Does not block. The list should usually be short or empty, so no sender filter is needed. |
| `reply` | Responds to an inbound `ask`. `requestId` comes from the injected `whisper-ask` message, `whisper({ action: "wait" })`, or `whisper({ action: "pending" })`. |

Keep `to` and `requestId` separate. `to` always means an agent id used for new outbound delivery. `requestId` means a specific inbound ask being answered. Even though `ask` blocks the caller, a receiver can have multiple inbound asks from different agents, or from parallel tool calls, so replies need a request id.

#### Inbound Delivery

Inbound `send` and `ask` envelopes are pushed into the receiver's conversation via pi message injection rather than requiring the receiver to poll. The sender's `urgency` field maps to a pi delivery mode:

| Urgency | Pi mode | Receiver experience |
|---|---|---|
| `interrupt` | `steer` | Delivered between tool calls in the current turn, before the next LLM call. Best for `ask`, where a peer is blocked. |
| `soon` | `followUp` | Delivered when the receiver would otherwise idle. Best for `send`, where no one is waiting. |
| `later` | `nextTurn` | Queued silently until the receiver's next user prompt. For low-priority FYIs. |

Both kinds are injected as `pi.sendMessage` with `display: true` and a `customType`: `whisper-send` or `whisper-ask`. The injected message carries `from`, `message`, and (for asks) `requestId` in its `details` so the model can call `whisper({ action: "reply", requestId, message })` directly.

`wait` and `pending` remain available as a pull-side API. `pending` is still the canonical way to enumerate outstanding asks the model hasn't answered yet, and `wait` keeps explicit blocking semantics for coordinator-style agents that prefer to sit idle until a peer pings them. Neither is required for normal coordination.

Inbound ask lifecycle:

1. Sender calls `whisper({ action: "ask", to, message, urgency? })` and blocks.
2. The receiver's whisper extension injects a `whisper-ask` message at the chosen urgency. The receiver may also discover it later via `pending` or by calling `wait`.
3. The ask remains pending until the receiver calls `reply`, the sender aborts, or the ask times out.
4. `reply` unblocks the sender's original `ask` call.

Mutable registry fields should stay intentionally small and operational:

| Field | Status | Notes |
|---|---|---|
| `description` | supported | Short, user/model-facing status like "reviewing auth tests". Cleared by passing an empty string. |
| `role` | possible later | Usually set by the spawning layer; only make mutable if agents need to advertise role changes. |
| `status` | reserved | Core lifecycle state (`pending`/`active`), not user-editable through the tool. |
| `meta` | possible later | Namespaced extension data if another consumer needs extra discovery fields. Do not add speculatively. |

`send` and `ask` are capped at 64 KB of message text. `ask`/`reply` is the only built-in conversational handshake; Whisper does not keep durable history after a message is delivered.

### Pi Events and Lifecycle Hooks

The extension subscribes to two pi lifecycle events:

| Event | Whisper behavior |
|---|---|
| `session_start` | Stores the active `ExtensionContext`, starts the local listener, resolves the startup name, publishes the registry record, begins the heartbeat, and sets footer status `whisper:<name>`. |
| `session_shutdown` | Clears footer status, stops heartbeat, removes the registry record, closes the listener, and drops the active context. |

The extension does not need `resources_discover`, `tool_call`, `context`, or provider events for the core Whisper feature.

### UI, Session, and Message Effects

Whisper uses pi APIs in these ways:

- `ctx.ui.setStatus("whisper", \`whisper:${name}\`)` shows the active name in the footer.
- `ctx.ui.notify(...)` reports replies, timeouts, and errors.
- `pi.sendMessage({ customType: "whisper-send" | "whisper-ask", display: true, details: { from, fromId, message, requestId? }, ... })` injects inbound envelopes into the receiver's conversation. The `deliverAs` option is set from the sender's `urgency` (`interrupt` → `steer`, `soon` → `followUp`, `later` → `nextTurn`).

Inbound envelopes are also held in an in-memory inbox for `whisper({ action: "wait" })` and a pending-asks map for `whisper({ action: "pending" })`. The custom message types are `whisper-send` and `whisper-ask`.

## Current IPC Implementation

The current extension implementation uses a per-process HTTP listener bound to `127.0.0.1` on an ephemeral port. Each registry record includes the listener address and a random bearer token used in the `x-whisper-token` header.

Current registry record shape:

| Field | Purpose |
|---|---|
| `version` | Protocol version. |
| `id` | Process-lifetime random id; canonical delivery target. |
| `name` | Human-readable local Whisper alias. |
| `pid` | Owning process id. |
| `host`, `port` | Current HTTP listener address. |
| `token` | Per-process bearer token for local delivery. |
| `cwd` | Session working directory, used in listings/completions. |
| `sessionFile` | Optional pi session file path. |
| `description` | Optional short status updated through `whisper({ action: "update" })`. |
| `startedAt`, `updatedAt` | Process start and heartbeat timestamps. |

Delivery endpoint:

- `POST /message`
- JSON body: `{ id?, kind: "send", from?, fromId?, message?, urgency?, timestamp? }`
- Header: `x-whisper-token: <target token>`
- Maximum body size: 64 KB
- Timeout: 5 seconds

This current HTTP transport is an implementation detail. The stable user/model contract is the single `whisper` tool, flags, events, and actions above.

## Target IPC Architecture

The target transport is Unix domain sockets on macOS/Linux and named pipes on Windows. This removes localhost port allocation and bearer tokens while keeping the same pi-facing surface.

### Registry and Consistency Model

The registry is a per-user directory: `~/.pi/whisper/` by default, overridden via `PI_WHISPER_DIR`. Each agent owns one JSON file inside, named by a hash of the agent id. Records are written atomically with tmp + rename and refreshed by heartbeat.

The registry is **eventually consistent and advisory**. A scan over N record files is not atomic; callers may observe a partially-started cohort, miss a record that exists, or briefly see stale data after a process dies.

**Connect-time failure is the authoritative liveness signal.** Registry liveness gates listing and lookup, but reachability is determined by attempting delivery to the target's listener.

### Target Identity Record

Target hierarchy-aware records add stable identity and lineage fields:

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Public live-agent id returned by `whisper({ action: "list" })` and used as the `to` target. Randomly minted once at process start. |
| `name` | yes | Human-readable name/alias. Unique within the user's registry when possible, but `id` is the canonical delivery target. |
| `pid`, `startedAt`, `updatedAt` | yes | Process bookkeeping. |
| `socketPath` | yes | UDS path or Windows named pipe. |
| `status` | yes | `pending` or `active`. |
| `parentId` | no | `id` of the spawning agent. Anchors lineage across parent name reuse. |
| `parentName` | no | Parent display name at spawn time, for humans and logs. |
| `groupId` | no | UUID identifying the spawn cohort. |
| `role` | no | Optional human-readable label, such as `researcher` or `reviewer`. |
| `description` | no | Short description of what this agent is doing. Mutable via `whisper({ action: "update", description })`. |

Subagent names can default to `<groupId>.<role>.<index>` for readability, but the format is not a contract. Lineage lives in fields, not name parsing.

`id`, not timestamps or names, anchors identity across name reuse. When an agent checks its parent, it resolves `parentId` directly rather than trusting a name that may have been reclaimed.

### Discovery API

Discovery is a query, not just a name lookup:

```ts
whisper.query({ id?, name?, parentId?, groupId?, role?, status? })
```

Returns active records matching all provided filters. Stale records are skipped and may be unlinked opportunistically.

User-facing helpers are sugar over `query`:

- `whisper.parent()` — `query({ id: me.parentId })[0] ?? null`.
- `whisper.siblings()` — `query({ groupId: me.groupId })` minus self.
- `whisper.children()` — `query({ parentId: me.id })`.
- `whisper.descendants()` — recursive walk over `children()`.

### Target Transport

Each agent listens on:

- macOS/Linux: Unix domain socket at `<registryDir>/<name>.sock`
- Windows: named pipe `\\.\pipe\pi-whisper-<sidHash>-<name>`

Wire format is newline-delimited JSON (NDJSON), one JSON object per line in each direction, with a maximum frame size of 1 MB.

Frame shape:

```json
{ "id": "...", "from": "...", "to": "...", "kind": "...", "body": {}, "ts": 0 }
```

Message kinds map directly to tool actions:

| Kind | Purpose |
|---|---|
| `send` | One-way inbound message. Stored in the receiver's inbox and surfaced to `wait`. |
| `ask` | Inbound request. Stored in the receiver's inbox and pending-ask map with `expectsReply: true`; the returned `requestId` is used with `reply`. |
| `reply` | Response to an outstanding `ask`. Unblocks the caller's pending tool call. |
| `error` | Negative response for expired, unknown, refused, or cancelled requests. |

Each process keeps an inbox queue for `wait`, a pending-inbound-asks map for `pending`/`reply`, and a pending-outbound-asks map for local `ask` calls waiting on replies. These maps are intentionally not durable; if either process exits, outstanding asks fail and queued inbound messages disappear.

If the protocol grows beyond a few operations, the body can move to JSON-RPC 2.0 without changing the transport.

### Authorization

Target authorization has two layers:

1. **Kernel-enforced**: registry directory `chmod 700`; sockets `chmod 600`; named pipes restricted to the current user's SID.
2. **Application-enforced**: every message carries `from`; the receiver looks up the sender and applies its own policy, such as accepting only from parent, siblings, or descendants.

No bearer token is needed once delivery moves from loopback HTTP to user-scoped sockets or pipes.

## Lifecycle

### Root Agent Startup

1. Resolve and validate the pi-facing name.
2. Mint `id` and `startedAt`.
3. Bind the listener.
4. Write an `active` registry record.
5. Begin heartbeat. Heartbeat preserves mutable fields like `description` when rewriting `updatedAt`.
6. Set pi footer status `whisper:<name>`.

### Subagent Startup

Subagent startup is identical except `name`, `parentId`, `parentName`, `groupId`, `role`, and listener path may be read from environment variables set by the parent. The child mints its own fresh `id`.

Spawn environment for hierarchy-aware children:

- `PI_WHISPER_NAME`
- `PI_WHISPER_PARENT_ID`
- `PI_WHISPER_PARENT_NAME`
- `PI_WHISPER_GROUP`
- `PI_WHISPER_ROLE`
- `PI_WHISPER_SOCKET`

### Spawning Children

Default flow is self-registration:

1. Parent picks a child name and listener path.
2. Parent spawns the child with environment variables.
3. Child boots, listens, and writes its own `active` record.
4. Parent reaches the child via connect-with-retry.

Coordinated cohorts can use pre-allocation:

1. Parent mints `groupId = uuid()`.
2. Parent writes one `pending` record per child with name, lineage, role, and expected listener path.
3. Parent spawns each child.
4. Each child boots, listens, and upgrades its record to `active`.

The parent does not bind the child's listener. Pre-allocation reserves the identity contract, not the socket or pipe itself.

### Heartbeat and Shutdown

- Heartbeat rewrites `updatedAt` every 5 seconds.
- `active` records expire after 30 seconds without heartbeat.
- `pending` records expire after 10 seconds without activation.
- On shutdown, the agent clears pi UI status, stops heartbeat, unlinks its listener, deletes its registry record, and closes the server.

### Name Collisions

- If a stale record exists at the target name, remove or overwrite it.
- If an active record exists and does not belong to this process identity, refuse the name.
- In the current HTTP implementation, ownership is checked by `pid + token`.
- In the target socket implementation, ownership is checked by `pid + id`.

## Orphan Policy

When a parent dies, children still carry `parentId` and `parentName`. Whisper should surface this as derived state, such as `parentAlive: boolean`, computed by checking whether the `parentId` record is still active.

Whether an orphan exits, re-parents, or continues independently is policy for the spawning/subagent layer, not for Whisper IPC.

## Hierarchy Is for Discovery, Not Routing

Child-to-child traffic should use direct connections. The hierarchy is a query overlay on a flat peer mesh; routing through parents adds latency, a single point of failure, and bottlenecks without benefit on localhost.

## Open Questions

- **Default authorization policy.** Current behavior accepts messages that present the registry token. Target socket behavior needs a default application policy, likely either "any active registry peer" or "lineage only".
- **Subagent integration point.** Whisper can carry lineage fields, but the pi subagent/spawn layer must decide exactly when to set `PI_WHISPER_*` environment variables and whether to pre-allocate cohorts.
- **Backpressure.** Frames are bounded and deliveries are short-lived, but a receiver flooded by many concurrent senders has no built-in flow control.
