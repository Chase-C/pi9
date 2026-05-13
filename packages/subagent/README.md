# @pi9/subagent

A Pi package that adds subagent delegation to Pi. It registers the `subagent` tool for spawning isolated SDK `AgentSession`s, renders live child-agent progress in the tool row, shows an auto-hidden progress widget, and provides a `/subagents` command for process-lifetime session management.

Use it for focused research, planning, review, bug investigation, test analysis, or implementation handoffs where a separate context window helps keep the parent conversation small. Each child receives its configured system prompt plus the prompt you provide; the child does not inherit the parent conversation history.

## Install for local development

```bash
npm install
npm run build --workspace=@pi9/subagent
pi install ./packages/subagent
```

For quick testing without installing:

```bash
npm run build --workspace=@pi9/subagent
pi -e ./packages/subagent
```

After edits, run the package build and reload Pi if needed.

## What the extension provides

- A `subagent` tool with `agents`, `list`, `run`, and `remove` actions. `run` accepts a mix of spawn and resume tasks in one call.
- Live progress updates while child agents are queued or running.
- Custom collapsed/expanded rendering for `subagent` tool results.
- An auto-hidden widget for active and retained resumable sessions.
- A `/subagents` command with Sessions, Agents, and Settings views.
- Process-lifetime resumable sessions for agents that opt in with `resumable: true`, with a per-task one-way override at completion.
- Per-task injection of named skills into a child's system prompt, with agent-level defaults declared in frontmatter.

## Agent discovery

Agents are markdown files discovered from:

1. User `${PI_AGENT_DIR ?? ~/.pi/agent}/agents`.
2. The nearest project `.pi/agents`, found by walking up from the tool execution `cwd`.

Each file is parsed as an agent definition and registered by its frontmatter `name` field, not by filename. Later-loaded project agents override user agents with the same runtime name.

## Define agents

Add an agent as a markdown file in a discovered `agents/` directory:

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
| `description` | yes | Short summary shown in error messages, tool results, and agent browsers. |
| `model` | no | Model for this agent, resolved through Pi's model registry. Use `provider/model` or an unambiguous model id. |
| `thinking` | no | Thinking level for the child session. |
| `tools` | no | Comma-separated tool allowlist passed to the child SDK session. |
| `skills` | no | Comma-separated default skill names injected into this agent's system prompt. Per-task `skills` fully replaces this list (no merge); use `none` or omit the field to declare none. |
| `resumable` | no | Boolean. Defaults to `false`. When `true`, sessions with a child `AgentSession` can be retained for this Pi process lifetime. Only completed resumable sessions can be resumed. A per-task `resumable: false` override discards the session immediately at completion. |

The markdown body after the frontmatter is trimmed and used as the child session's system prompt.

## Use the tool

The tool accepts a required `action`: `agents`, `list`, `run`, or `remove`.

### `action: "agents"`

List configured agent definitions. Each entry carries the agent's `tools` and any default `skills` declared in its frontmatter alongside the rest of its config.

```ts
subagent({ action: "agents" })
```

### `action: "list"`

List active and retained subagent sessions. Each row carries a `kind` tag (`"background" | "retained"`) describing how it was dispatched. Without a filter, all active and retained sessions are returned:

```ts
subagent({ action: "list" })
```

Optionally pass a `status` array to filter by effective status. Valid values: `queued`, `running`, `completed`, `error`, `aborted`, `interrupted`, `skipped`. An empty array returns no sessions (distinct from no filter):

```ts
subagent({ action: "list", status: ["completed", "error"] })
```

The legacy `type` parameter is rejected with a migration error. Use `action: "agents"` for definitions or `action: "list"` for sessions. Skills listing is no longer exposed through this tool — the parent already discovers skills.

### `action: "run"`

`run` takes a `tasks` array. Each task is either a **spawn** (carrying `agent`) or a **resume** (carrying `sessionId`). The two are mutually exclusive — providing both is rejected, and providing neither is rejected.

Spawn task fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `agent` | yes | Runtime agent name from a discovered agent definition. |
| `prompt` | yes | The task to delegate. |
| `label` | no | Human-readable identifier shown in widgets and logs in place of the agent name. |
| `resumable` | no | Boolean override of the agent's frontmatter default. The decision is one-way at completion: a `false` override discards the session immediately. |
| `model` | no | Override the agent's configured model. |
| `thinking` | no | Override the agent's configured thinking level. |
| `cwd` | no | Working directory for the child session. Relative paths resolve against the parent `cwd`. |
| `skills` | no | Skill names to inject into the child's system prompt. Fully replaces the agent's default `skills` (no merge); pass `[]` to opt out of defaults. Unknown names are a hard error. Explicit skills bypass each skill's `disable-model-invocation` flag. |

Resume task fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `sessionId` | yes | A retained, `completed` resumable session id. |
| `prompt` | yes | The follow-up to send to the resumed session. |
| `label` | no | Re-asserts the label; a new value overwrites the stored one. |
| `resumable` | no | Re-asserts the resumable override. `model`, `thinking`, `cwd`, `skills`, and `agent` are rejected on resume. |

Single spawn:

```ts
subagent({
  action: "run",
  tasks: [
    { agent: "scout", prompt: "Find the auth entry points and summarize relevant files." }
  ]
})
```

Bounded multi-task spawn with labels and skills:

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

Batch-level `background: true` dispatches the run non-blocking. The call returns immediately with initial session views; children continue under a manager-owned `AbortController` and remain visible in `list` until removed or collected. `background` is rejected on individual tasks — it is a batch-level flag.

```ts
subagent({
  action: "run",
  background: true,
  tasks: [
    { agent: "scout", prompt: "Map auth code; respond when complete." }
  ]
})
```

Background results persist until removed or collected — call `subagent results` to retrieve and either pass `remove: true` or call `subagent remove` afterward.

### `action: "results"`

```ts
subagent({ action: "results", sessionIds: ["..."] })                  // peek without removing
subagent({ action: "results", sessionIds: ["..."], remove: true })    // collect terminal entries and sweep them
```

`results` never blocks. It returns one entry per id in input order (duplicates allowed):

```ts
type BackgroundResult =
  | { sessionId: string; ready: true; result: AgentRunResult }
  | { sessionId: string; ready: false; status: "queued" | "running"; elapsedMs: number; agent: string; label?: string }
  | { sessionId: string; error: string };
```

- Terminal entries (`completed`, `error`, `aborted`, `interrupted`, `skipped`, plus resume failures) return their full `AgentRunResult` under `{ ready: true, result }`.
- Queued/running entries return `{ ready: false, status, elapsedMs, agent, label? }`. `elapsedMs` is measured from when the child started (running) or from when the agent was created (queued).
- Unknown ids return `{ sessionId, error: "Unknown subagent session: <id>" }`. The overall response stays `isError: false` — partial-success is success.
- `remove: true` sweeps terminal entries after their result is collected. Running entries are never removed regardless of the flag. A subsequent `results` call for a swept id returns the unknown-id error.
- The action is not background-only: passing a retained resumable `sessionId` returns its result the same way.

### `action: "remove"`

```ts
subagent({ action: "remove", sessionIds: ["..."] })        // remove specific sessions; running ones are aborted
subagent({ action: "remove", scope: "retained" })          // remove all retained resumable sessions
subagent({ action: "remove", scope: "non-running" })       // remove everything that isn't currently running
subagent({ action: "remove", scope: "background" })        // remove all background sessions (terminal and running)
```

Exactly one of `sessionIds` or `scope` is required; bare or conflicting calls are rejected. The response shape is `{ removed, aborted, sessionIds, errors }`. Unknown ids appear in `errors[]` without setting `isError` — partial-success is success.

The parent remains responsible for sequencing. If later work depends on earlier output, make one `subagent` call, inspect the result, then make the next call.

## Live tool rendering

`subagent run` streams live updates into the tool result while children run, for both spawn and resume tasks.

- Collapsed rendering shows an aggregate group line, such as task count, status counts, and overall outcome.
- Expanded rendering shows one row per child session with agent name (or per-task `label`), status, turn/tool counts, elapsed time, active tool, live message snippet, and final outcome.
- Multi-task runs keep input order in final results and group related child rows together.
- Mixed child failures mark the overall tool result as `isError` while preserving successful child results.

Renderer failures fall back to simple text/JSON output instead of breaking the tool call.

## Progress widget and settings

The extension also updates a lightweight widget outside the tool row.

- The widget appears while there are active sessions or retained resumable sessions.
- It auto-hides when there are no active or retained sessions.
- A single visible session renders a compact session line.
- Multiple visible sessions render a one-line summary of active and retained counts.

Configure widget placement with `/subagents settings`:

| Value | Behavior |
| --- | --- |
| `belowEditor` | Show the widget below the editor. This is the default. |
| `aboveEditor` | Show the widget above the editor. |
| `off` | Disable only the persistent widget. Tool rendering and `/subagents` still work. |

The settings are global for the user and stored at `${PI_AGENT_DIR ?? ~/.pi/agent}/subagent/settings.json`. The file is normalized with defaults when saved. Supported keys:

```json
{
  "widgetPlacement": "belowEditor",
  "runtime": {
    "maxTasksPerRun": 8,
    "maxConcurrentSubagents": 4,
    "defaultResumable": false
  },
  "agentDiscovery": {
    "includeUserAgents": true,
    "includeProjectAgents": true,
    "projectAgentsStrategy": "nearest",
    "agentFileExtensions": [".md"],
    "duplicateNamePolicy": "projectOverridesUser",
    "warnOnInvalidAgents": false
  },
  "display": {
    "promptPreviewLength": 120,
    "messageSnippetLength": 200,
    "outputSnippetLength": 400,
    "outputSnippetMaxLines": 8,
    "resumeMessageSnippetLength": 80,
    "toolCallLabelMaxLength": 60,
    "collapsedAgentListLimit": 8,
    "collapsedDescriptionLength": 100,
    "widgetShowRetainedSessions": true
  }
}
```

`runtime.defaultResumable` only applies when an agent definition omits `resumable`; explicit frontmatter and per-task overrides still win. `agentDiscovery.duplicateNamePolicy` controls which source wins when user and project agents share a runtime name.

## `/subagents` command

Run `/subagents` to inspect and manage subagents from the UI.

When active or retained sessions exist, `/subagents` opens the Sessions view. From there you can:

- Inspect a session's status, agent metadata, prompt preview, progress counters, timestamps, usage, output/error snippets, and available actions.
- Resume a completed resumable session. The command asks for a follow-up prompt in an editor, runs with a cancellable loader, updates the widget live, and appends a concise custom result message to the main conversation. Cancelling the loader interrupts the child run instead of hiding background work.
- Remove a retained non-running resumable session.

If no active or retained sessions exist, `/subagents` opens the read-only Agents browser instead. The browser lists discovered user/project agent definitions and lets you inspect model, thinking, tools, resumable status, and source path metadata. It does not launch agents.

Run `/subagents settings` to open the Settings view directly.

## Background subagents

Background dispatch lets a `run` batch return immediately so the parent agent can continue working while children execute. Pass batch-level `background: true` on `action: "run"`.

Lifecycle:

1. The tool call returns immediately with `view: "background-started"` and the initial session views.
2. Children run under a manager-owned `AbortController` and are not bound to the parent tool-call signal — completing the parent tool call does not cancel them.
3. Background sessions appear in `subagent list` with `kind: "background"` and the appropriate `status`.
4. When a background session finishes, it is retained until removed or collected with `subagent results` (`{ remove: true }`) or `subagent remove`.

`kind` and `resumable` are independent:

- `kind: "retained"` rows in `list` always have `resumable: true` (resumable foreground sessions retained for the current Pi process).
- `kind: "background"` rows may be either resumable or not. The point of the background-retention rule is that a non-resumable background job's result is still visible after completion until it is removed or collected.

Removal:

```ts
subagent({ action: "remove", scope: "background" })   // remove all background sessions (running ones aborted)
subagent({ action: "remove", sessionIds: ["..."] })   // remove specific sessions; running ones aborted
```

## Session lifetime and retention

Session management is intentionally process-lifetime only.

- Active queued/running sessions are visible while they exist.
- Resumable sessions with a child `AgentSession` are retained after completion or failure only for the current Pi extension process.
- Completed non-resumable sessions disappear from the session UI after the tool result settles.
- Restarting Pi or reloading the extension releases retained sessions; sessions are not restored from disk.
- `sessionId` identifies a retained process-local session, not a durable record.
- Tool results include `resumable` and include `sessionId` only when a resumable child has or had a child `AgentSession`. Check `resumable` and the status before offering follow-up behavior.
- Only `status: "completed"` resumable sessions can be resumed. Failed, aborted, and interrupted resumable sessions are inspect/remove-only.
- Command-driven resume messages include bounded metadata plus output/error snippets, not the full child transcript.

## Status meanings

Tool results and UI session rows use these terminal states:

| Status | Meaning | Resume? |
| --- | --- | --- |
| `completed` | The child run finished and returned output. | Yes, if `resumable: true`. |
| `error` | The agent was unknown, failed before running, or the child session failed without cancellation semantics. | No. |
| `aborted` | A running session was explicitly aborted, such as by removing it directly through the tool API. `Agent.abort()` calls `session.abort()` on the underlying SDK session and finalizes the agent with this status. | No. |
| `interrupted` | A running child was stopped because the parent tool/command was cancelled. | No. |
| `skipped` | A queued task never started because the parent was cancelled before a child `AgentSession` was created. | No. |

`queued` and `running` are active non-terminal states.

## Non-interactive behavior

The core `subagent` tool works in non-interactive modes and still returns structured text/details. UI surfaces degrade gracefully:

- Tool renderers fall back to plain text/JSON when custom rendering is unavailable.
- Widget updates no-op when `ctx.hasUI` or `setWidget` is unavailable.
- `/subagents` reports summaries/settings when possible instead of opening custom TUI views.
- UI/config/render failures notify or warn where possible and do not interrupt child execution.

## Results

Tool results preserve input order and are returned in both text content (JSON) and `details.results`:

```ts
{
  results: [
    {
      agent: "scout",
      label: "frontend auth",
      prompt: "Map frontend auth code and list key files.",
      status: "completed",
      output: "...",
      model: "anthropic/claude-sonnet-4",
      resumable: true,
      resumed: false,
      sessionId: "..."
    },
    {
      agent: "scout",
      prompt: "Use your previous findings to propose the smallest implementation plan.",
      status: "completed",
      output: "...",
      model: "anthropic/claude-sonnet-4",
      resumable: true,
      resumed: true,
      sessionId: "..."
    },
    {
      agent: "missing",
      prompt: "...",
      status: "error",
      error: "Unknown agent: missing. Available agents: ...",
      resumable: false,
      resumed: false
    }
  ],
  group: { /* live/final grouped UI DTO */ }
}
```

Each result carries:

- `resumed`: `true` if this task continued an existing session, `false` for a fresh spawn (and for tasks that errored before attaching to a session).
- `resumable`: `true` only when a child `AgentSession` exists or existed and the effective `resumable` flag is on.
- `sessionId`: present only when `resumable` is true.
- `label`: present when the task or a prior invocation supplied one.

`isError` is set when any run has a non-`completed` status. Unknown agents, unknown sessionIds, and child-session failures are reported as failed per-task results without discarding other scheduled results.

## Limits and current constraints

- `action` is required; legacy `{ tasks: [...] }` calls and the previous `start`/`resume`/`clear` actions are rejected.
- Maximum tasks per `run` tool call defaults to eight and can be changed with `runtime.maxTasksPerRun`.
- Maximum concurrent child sessions defaults to four and can be changed with `runtime.maxConcurrentSubagents`.
- A given `sessionId` cannot be resumed more than once concurrently; a second concurrent resume of the same session surfaces as a per-task error.
- Agent discovery checks user agents and the nearest project agents for the execution `cwd` by default. It can be narrowed with `agentDiscovery` settings; there is no per-call `agentScope` parameter.
- No per-run timeout is exposed beyond parent abort/cancellation.
- Child sessions isolate Pi message history/context, but they still run inside the same extension process.
- Resumable sessions are retained only for the current Pi process lifetime and only for agents with `resumable: true` (or a per-task `resumable: true` override on a session that has an attached child).

## MVP non-goals

The current UI is intentionally lightweight. It does not provide:

- Restart-resumable sessions after a Pi process restart.
- Branch-aware or project-aware durable session persistence.
- A manual launch wizard for starting agents from `/subagents`.
- Abort/retry controls from the `/subagents` UI.
- A full orchestration dashboard.
