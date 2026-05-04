# @pi9/whisper

Whisper is a pi extension for local agent-to-agent messages. Each pi process starts a localhost HTTP listener and publishes a small heartbeat record under `~/.pi/whisper` so other local pi agents can find it by name. It uses only Node built-ins and works on macOS, Linux, and Windows.

## Install / run

From this package directory:

```bash
npm run build
pi -e ./dist/index.js --whisper-name alice
```

Or install it as a pi package from the monorepo/package path.

## Naming agents

Set a name at startup:

```bash
pi -e ./dist/index.js --whisper-name alice
```

Or inside pi:

```text
/whisper-name alice
```

Names must be 1-64 characters and can contain letters, numbers, `.`, `_`, and `-`.

## Commands

- `/whisper-name [name]` - show or set this agent's name.
- `/whisper-list` - list reachable local agents.
- `/whisper-send <agent> <message>` - send a user prompt to another agent; the receiving agent will act on it.
- `/whisper-note <agent> <message>` - display a note in another agent without triggering a turn.

## Tools exposed to agents

- `whisper_list_agents` - list active local agents.
- `whisper_send` - send a message to a named agent.
  - `mode: "user"` makes the target receive it as a user prompt.
  - `mode: "note"` only displays it in the target session.

## IPC details

- Discovery directory: `~/.pi/whisper` by default.
- Override discovery directory with `PI_WHISPER_DIR`.
- Override startup name with `PI_WHISPER_NAME` or `--whisper-name`.
- Records expire after 30 seconds without a heartbeat.
- Transport is HTTP bound to `127.0.0.1` with per-process bearer tokens stored in the local registry record.
