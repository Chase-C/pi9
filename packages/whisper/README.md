# @pi9/whisper

Whisper is a pi extension for local agent-to-agent messages. Each pi process starts a localhost HTTP listener and publishes a heartbeat record under `~/.pi/whisper` so other local pi agents can find it by id.

## Install / run

```bash
pi install npm:@pi9/whisper
```

For local development from this package directory:

```bash
npm run build
pi -e ./dist/index.js --whisper-name alice
```

## Naming agents

Set a name at startup:

```bash
pi -e ./dist/index.js --whisper-name alice
```

Names must be 1-64 characters and can contain letters, numbers, `.`, `_`, and `-`. Names are human-readable aliases; each process also gets a fresh random `id`, and that `id` is the canonical delivery target.

Startup precedence is:

1. `--whisper-name`
2. `PI_WHISPER_NAME`
3. fallback `pi-<pid>`

Names are not restored from session entries.

## Tool exposed to agents

Whisper registers a single tool: `whisper`.

Examples:

```ts
whisper({ action: "me" })
whisper({ action: "list" })
whisper({ action: "update", description: "reviewing auth tests" })
whisper({ action: "send", to: "<agent-id>", message: "hello" })
whisper({ action: "ask", to: "<agent-id>", message: "Ready to merge?", timeoutMs: 30000 })
whisper({ action: "pending" })
whisper({ action: "reply", requestId: "<request-id>", message: "Yes" })
whisper({ action: "wait", timeoutMs: 30000 })
```

Actions:

- `me` - return this agent's active registry record, including `id` and `name`.
- `list` - list active local agents, including each agent's `id`, `name`, `cwd`, `description`, `pid`, and `updatedAt`.
- `update` - set this agent's short `description`; pass an empty string to clear it.
- `send` - send a non-blocking message to an agent id.
- `ask` - send a request and wait for the target's reply.
- `pending` - list inbound asks that still need replies.
- `reply` - answer an inbound ask by request ID.
- `wait` - drain queued messages or wait for the next one.

`send` and `ask` fields:

- `to` - target agent id returned by `list`.
- `message` - message text, capped at 64 KB.
- `urgency` - optional `interrupt`, `soon`, or `later`; defaults to `soon` for `send` and `interrupt` for `ask`.
- `timeoutMs` - optional timeout for `ask`.

`reply` requires the `requestId` from an injected ask or from `pending`. `wait` accepts an optional `timeoutMs`.

Inbound sends are injected into the target conversation as `customType: "whisper-send"`. Inbound asks use `customType: "whisper-ask"` and remain pending until replied to, cancelled, or expired.

Urgency maps to pi delivery timing:

- `interrupt` → `steer`
- `soon` → `followUp`
- `later` → `nextTurn`

## IPC details

- Discovery directory: `~/.pi/whisper` by default.
- Override discovery directory with `PI_WHISPER_DIR`.
- Override startup name with `PI_WHISPER_NAME` or `--whisper-name`.
- Records expire after 30 seconds without a heartbeat.
- Transport is HTTP bound to `127.0.0.1` with per-process bearer tokens stored in the local registry record.
