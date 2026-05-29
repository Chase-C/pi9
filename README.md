# @pi9/subagent

A Pi package that adds subagent delegation: a single `subagent` tool the main agent can use to spawn isolated child `AgentSession`s, see their progress live, and pick up where they left off.

Reach for it when the work would crowd the parent conversation or benefits from an independent perspective: focused research, planning, review, bug investigation, test analysis, and implementation handoffs.

What's distinctive about this package:

- **Resumable sessions.** Agents can opt in to being resumable, letting the parent send follow-up prompts to the same child later. The child keeps its accumulated context across resumes instead of starting cold each time.
- **Background dispatch.** A batch can be dispatched in the background so the parent doesn't wait. Children keep running independently of the call that started them, and the parent is notified when they finish — the notification style is configurable so it doesn't have to interrupt the active turn.
- **Recursive subagents.** Subagents can spawn their own subagents, and the parent sees the whole tree as one coherent run: nested children appear under their parent, counts and elapsed time aggregate across the tree, and a single shared concurrency limit applies across all levels so recursive fan-out stays bounded.
- **Minimal API surface.** A single tool covers listing agents, listing sessions, spawning, resuming, fetching results, and cleanup. Spawn and resume tasks can be mixed in the same batch, so the main agent rarely needs more than one call to dispatch a round of work.
- **Small, opinionated tool prompt.** The tool description is concise by design to avoid bloating context. It gives the parent clear "when to delegate" and "when to skip" guidance, and uses a compact call-shape signature so the schema is legible without prose for every parameter.
- **Configurable without code.** Concurrency, default behaviors, notification style, widget placement, and discovery rules are all settings, editable from `/subagents settings` or a single JSON file. The defaults are chosen so most projects don't have to touch them.

## Install

```bash
pi install npm:@pi9/subagent
```

For quick testing without installing (in this repo):

```bash
pi -e .
```

## Agent discovery

Agents are markdown files discovered from:

1. User `${PI_AGENT_DIR ?? ~/.pi/agent}/agents`.
2. The nearest project `.pi/agents`, found by walking up from the tool's `cwd`.

Each file is registered by its frontmatter `name`, not by filename. Project agents override user agents with the same name.

## Define agents

Add a markdown file in a discovered `agents/` directory:

```markdown
---
name: scout
description: Read-only codebase reconnaissance
model: anthropic/claude-sonnet-4
tools: read, bash
skills: codesearch
resumable: true
---

You are a fast codebase scout. Inspect the repository and return concise, evidence-backed findings with file paths.
```

Supported frontmatter:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Runtime agent name used in tool calls. |
| `description` | yes | Short summary shown in tool results and browsers. |
| `model` | no | Model for this agent. Use `provider/model` or an unambiguous model id. |
| `thinking` | no | Thinking level for the child session. |
| `tools` | no | Comma-separated tool allowlist. If set, include `subagent` for agents that should be able to delegate recursively. |
| `skills` | no | Comma-separated default skill names injected into the system prompt. Per-task `skills` replaces this list (no merge); use `none` or omit to declare none. |
| `resumable` | no | Boolean. When `true`, the session is retained after completion or failure and can be resumed with a follow-up prompt. Retention lasts for the current Pi process only — restart or extension reload releases it. |

The markdown body is trimmed and used as the child's system prompt.

## Use the tool

The tool accepts a required `action`: `agents`, `list`, `run`, `results`, or `remove`.

### `action: "agents"`

List configured agent definitions, including each agent's `tools` and default `skills`.

```ts
subagent({ action: "agents" })
```

### `action: "list"`

List active and retained subagent sessions. Each row carries two independent tags:

- `dispatch: "foreground" | "background"` — how the run was started.
- `retention: "transient" | "persistent"` — whether the session survives in the catalog after its current attempt settles. Background sessions are always persistent; foreground sessions are persistent only when resumable.

```ts
subagent({ action: "list" })
subagent({ action: "list", status: ["completed", "error"] })
```

An empty `status` array returns no sessions (distinct from no filter). Valid values:

| Status | Meaning |
| --- | --- |
| `queued` | Waiting on the shared concurrency queue. |
| `running` | Actively executing. |
| `completed` | Finished and returned output. |
| `error` | Agent unknown, failed before running, or the child session failed without cancellation semantics. |
| `aborted` | Explicitly aborted (e.g., via `subagent remove`). |
| `interrupted` | Stopped because the parent tool/command was cancelled. |
| `skipped` | Queued task never started because the parent was cancelled before a child session was created. |

A `completed` resumable session can be resumed; a resume attempt that fails before re-attaching is also retryable. All other terminal states are inspect/remove-only.

### `action: "run"`

`run` takes a `tasks` array. Each task is either a **spawn** (carrying `agent`) or a **resume** (carrying `sessionId`). Providing both or neither is rejected.

Spawn task fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `agent` | yes | Runtime agent name from a discovered definition. |
| `prompt` | yes | The task to delegate. |
| `label` | no | Human-readable identifier shown in widgets and logs in place of the agent name. |
| `resumable` | no | Boolean override of the agent default. A `false` override discards the session immediately at completion. |
| `model`, `thinking`, `cwd` | no | Override the agent's configured model, thinking level, or working directory. Relative `cwd` resolves against the parent. |
| `skills` | no | Skill names to inject. Fully replaces the agent's default `skills` (no merge); pass `[]` to opt out. Unknown names are a hard error. Explicit skills bypass each skill's `disable-model-invocation` flag. |

Resume task fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `sessionId` | yes | A retained resumable session that is completed, or whose last resume failed before re-attaching. |
| `prompt` | yes | The follow-up to send. |
| `label`, `resumable` | no | Re-assert label or resumable override. `model`, `thinking`, `cwd`, `skills`, and `agent` are rejected on resume. |

Single spawn:

```ts
subagent({
  action: "run",
  tasks: [
    { agent: "scout", prompt: "Find the auth entry points and summarize relevant files." }
  ]
})
```

Multi-task spawn with labels and skills:

```ts
subagent({
  action: "run",
  tasks: [
    { agent: "scout", label: "frontend auth", prompt: "Map frontend auth code and list key files.", skills: ["codesearch"] },
    { agent: "scout", label: "backend auth", prompt: "Map backend auth code and list key files." },
    { agent: "reviewer", prompt: "Review auth-related tests and summarize coverage gaps." }
  ]
})
```

Mixed spawn and resume in one call:

```ts
subagent({
  action: "run",
  tasks: [
    { sessionId: "...", prompt: "Use your previous findings to propose the smallest implementation plan." },
    { agent: "reviewer", prompt: "Independently review the new plan once it lands." }
  ]
})
```

Batch-level `background: true` dispatches the run non-blocking. The call returns immediately with initial session views; children keep running independently of the call that started them and remain visible in `list` until removed or collected, even if the agent isn't resumable. `background` is a batch-level flag and is rejected on individual tasks.

```ts
subagent({
  action: "run",
  background: true,
  tasks: [{ agent: "scout", prompt: "Map auth code; respond when complete." }]
})
```

The parent remains responsible for sequencing. If later work depends on earlier output, make one `subagent` call, inspect the result, then make the next call.

### `action: "results"`

```ts
subagent({ action: "results", sessionIds: ["..."] })                  // peek without removing
subagent({ action: "results", sessionIds: ["..."], remove: true })    // collect terminal entries and sweep them
```

`results` never blocks. It returns one entry per id in input order (duplicates allowed):

```ts
type SubagentResult =
  | { sessionId?: string; ready: true; result: AgentResult }
  | { sessionId: string; ready: false; status: "queued" | "running"; elapsedMs: number; agent: string; label?: string }
  | { sessionId: string; error: string };
```

- Terminal entries return the projected `AgentResult` (see [Result shape](#result-shape)) under `{ ready: true, result }`.
- Queued/running entries return `{ ready: false, status, elapsedMs, agent, label? }`. `elapsedMs` is measured from when the child started (running) or from when the current attempt was queued (queued).
- Unknown ids return `{ sessionId, error: "Unknown subagent session: <id>" }`. The overall response stays `isError: false` — partial success is success.
- `remove: true` sweeps terminal entries after collection. Running entries are never removed regardless of the flag.
- Not background-only: a retained resumable `sessionId` can be inspected this way too.

### `action: "remove"`

```ts
subagent({ action: "remove", sessionIds: ["..."] })        // remove specific sessions; running ones are aborted
subagent({ action: "remove", scope: "retained" })          // remove all retained resumable sessions
subagent({ action: "remove", scope: "non-running" })       // remove everything that isn't currently running
subagent({ action: "remove", scope: "background" })        // remove all background sessions (terminal and running)
```

Exactly one of `sessionIds` or `scope` is required. The response shape is `{ removed, aborted, sessionIds, errors }`. Unknown ids appear in `errors[]` without setting `isError`.

### Result shape

`run` and `results` share one envelope. A terminal entry's `result` looks like:

```ts
{
  view: "results",
  results: [
    {
      sessionId: "...",
      ready: true,
      result: {
        agent: "scout",
        label: "frontend auth",
        prompt: "Map frontend auth code and list key files.",
        status: "completed",
        output: "...",
        model: "anthropic/claude-sonnet-4",
        resumable: true,
        resumed: false,
        sessionId: "...",
        turns: 6,
        tokens: 18432,
        elapsedMs: 21044
      }
    }
  ]
}
```

`output` (or `error` for non-`completed` statuses) is the child's **full, untruncated** text — only the TUI compacts it. Both the inner `result.sessionId` and the outer envelope `sessionId` are present only when the result is resumable.

## Live rendering

While a `run` is executing, the tool row shows one line per child with status, agent or `label`, turns, tokens, elapsed time, and its most recent tool calls. Finished children collapse to just their row:

```text
  ⠋ reviewer  auth review · 2 turns · 18420 tokens · 37s
    ⠋ bash npm test · 12s
    ✓ grep "formatRunSessionLine" in src · 1s
    ✓ read src/view/tool-result-lines.ts · 0s
    +2 additional tool calls
```

Expanding the tool call shows each child's prompt and full tool history. For resumed sessions, every previous run is shown as its own section above the current run, with its own prompt, tool history, and output. Mixed child failures still preserve successful results.

## Progress widget

A lightweight widget appears outside the tool row while there are active or retained resumable sessions, and auto-hides otherwise. Nested children appear under their parent with depth-based indentation.

Configure placement and layout in `/subagents settings`:

| Setting | Values |
| --- | --- |
| `widgetPlacement` | `belowEditor` (default), `aboveEditor`, `off`. `off` disables only the widget; tool rendering and `/subagents` still work. |
| `widgetLayout` | `auto` (default — columns when terminal is wide enough, otherwise stacked), `columns`, `stacked`. |

## Settings

Settings are global per user and stored at `${PI_AGENT_DIR ?? ~/.pi/agent}/subagent/settings.json`. The file is normalized with defaults the first time it's written, so opening it after a fresh install shows every supported key with its current value.

The runtime knobs are the ones most users will reach for:

```json
{
  "runtime": {
    "maxTasksPerRun": 8,
    "maxConcurrentSubagents": 4,
    "defaultResumable": false,
    "backgroundNotify": "auto"
  }
}
```

- `maxConcurrentSubagents` is a **tree-wide** cap across recursive subagents (one shared queue owns the whole subagent tree).
- `defaultResumable` only applies when an agent definition omits `resumable`; explicit frontmatter and per-task overrides still win.
- `backgroundNotify` controls how a finishing background subagent notifies the parent:
  - `auto` (default) — coalesce completion metadata and deliver it once the parent is idle.
  - `steer` — inject a steering-style notification into the currently active run, falling back to a new turn if idle.
  - `none` — do not notify; the parent must call `subagent list` or `subagent results` to discover completions.

Notifications carry only metadata (session ids, agent, label, terminal status, elapsed time) and direct the parent to call `subagent results` for the actual output.

Beyond runtime, the settings file also has an `agentDiscovery` section (toggles for user/project sources, file extensions, duplicate-name policy) and a `display` section (truncation lengths and widget row caps). Defaults are tuned to be reasonable; reach for them only when something is being cut off or you need to narrow discovery.

`/subagents settings` exposes the common controls; the rarer discovery and display knobs are file-only.

## `/subagents` command

Run `/subagents` to inspect and manage subagents from the UI.

When active or retained sessions exist, it opens the Sessions view, where you can:

- Inspect status, agent metadata, prompt preview, counters, timestamps, usage, and output/error snippets.
- Resume a completed resumable session (or a resume attempt that failed before re-attaching). The command asks for a follow-up prompt, runs with a cancellable loader, updates the widget live, and appends a concise result message to the main conversation.
- Remove a retained non-running session.
- Open Settings with `s`, or switch to the Agents browser with `tab` when discovery is available.

If no sessions exist, `/subagents` opens the read-only Agents browser, which lists discovered agent definitions and their metadata. It does not launch agents.

Run `/subagents settings` to open Settings directly. All views share the same movement keys, including configured select keybindings and `j`/`k`.

## Architecture

```
src/
├── index.ts         — Extension entry; wires the registry, manager, tool, command, and widget.
├── schema.ts        — Zod schemas for tool parameters and structured results.
├── config/          — Settings types, defaults, and `settings.json` load/save.
├── domain/          — Pure domain model.
│   ├── agent.ts          — The Agent class: one child session, its attempts, and lifecycle.
│   ├── agent-registry.ts — Discovers and indexes agent definitions from user/project dirs.
│   ├── agent-snapshot.ts — Immutable state view used for rendering.
│   └── ...               — Config parsing, result projection, attempt/finalize/decision helpers.
├── runtime/         — Execution machinery.
│   ├── agent-manager.ts  — Top-level coordinator owning the registry, queue, and run groups.
│   ├── task-queue.ts     — Tree-wide concurrency queue shared across recursive subagents.
│   ├── run-group.ts      — One `run` call: tracks input order and surfaces tree state.
│   ├── run-agent.ts      — Builds and runs the underlying SDK AgentSession for one attempt.
│   └── ...               — Attempt dispatch, background notifier, extension cache, timing.
├── tool/            — The `subagent` tool: definition, action handlers, and the factory injected into children.
├── command/         — The `/subagents` slash command: registration, multi-step flows, and a `components/` subfolder with Sessions/Agents/Settings/resume-loader TUI components.
├── ui/widget.ts     — The persistent progress widget shown outside the tool row.
└── view/            — Rendering helpers shared by tool, command, and widget.
    ├── tool-result-lines.ts — Collapsed/expanded line generation for the tool row.
    ├── session-lines.ts     — Per-session line formatting used by widget and tool row.
    ├── widget-component.ts  — Top-level widget renderer with stacked vs. side-by-side layout.
    └── ...                  — Details payloads, serialization, resume message, format/view helpers.
```
