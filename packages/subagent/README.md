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
| `resumable` | no | Boolean. Defaults to `false`. When `true`, sessions with a child `AgentSession` can be retained for this Pi process lifetime. Completed resumable sessions can be resumed, and resume attempts that fail before re-attaching to the retained session remain retryable. A per-task `resumable: false` override discards the session immediately at completion. |

The markdown body after the frontmatter is trimmed and used as the child session's system prompt.

## Use the tool

The tool accepts a required `action`: `agents`, `list`, `run`, or `remove`.

### `action: "agents"`

List configured agent definitions. Each entry carries the agent's `tools` and any default `skills` declared in its frontmatter alongside the rest of its config.

```ts
subagent({ action: "agents" })
```

### `action: "list"`

List active and retained subagent sessions. Each row carries two independent tags:

- `dispatch: "foreground" | "background"` — how the run was started.
- `retention: "transient" | "persistent"` — whether the session survives in the catalog after its current attempt settles. Background sessions are always persistent; foreground sessions are persistent only when resumable.

Without a filter, all active and retained sessions are returned:

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
| `sessionId` | yes | A retained resumable session id that is completed, or that last failed before re-attaching during resume. |
| `prompt` | yes | The follow-up to send to the resumed session. |
| `label` | no | Re-asserts the label; a new value overwrites the stored one, while omitting it keeps the stored label. |
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
  | { sessionId?: string; ready: true; result: AgentResult }
  | { sessionId: string; ready: false; status: "queued" | "running"; elapsedMs: number; agent: string; label?: string }
  | { sessionId: string; error: string };
```

- Terminal entries (`completed`, `error`, `aborted`, `interrupted`, `skipped`, plus resume failures) return the same projected `result` as `action: "run"` (the `AgentResult` shape below, including `turns`, `tokens`, and `elapsedMs`) under `{ ready: true, result }`. `action: "results"` terminal entries include the requested `sessionId`; synchronous `action: "run"` entries include `sessionId` only when the result is resumable/collectable. Both actions share one results envelope: the in-process `details.results` carries the terminal/live **snapshots** (what the renderer and HTML export consume), and the text-content JSON above is projected from those terminal snapshots by the one `toResult` projection.
- Queued/running entries return `{ ready: false, status, elapsedMs, agent, label? }`. `elapsedMs` is measured from when the child started (running) or from when the current attempt was queued (queued).
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

### Tool call title

While a foreground `run` is executing, the call title shows live run counts and elapsed time instead of task labels:

```text
subagent run · 2 running · 1 queued · 3 finished · 1m24s
```

- `running`/`queued`/`finished` count sessions by effective status; `finished` covers every terminal outcome (`completed`, `error`, `aborted`, `interrupted`, `skipped`).
- Counts include nested child subagents: the subtree is counted when present, otherwise the flat batch.
- `elapsed` is wall-clock time since the parent `run` started, not summed child runtime.
- Before the first live result (and for older non-`run` call sites), the title falls back to the task count, e.g. `subagent run · 3 tasks`.

### Collapsed rendering

Collapsed output shows one row per child session — agent name (or per-task `label`), status, turn count, token count, and elapsed time — with up to the three most recent tool calls beneath it:

```text
  ⠋ reviewer  auth review · 2 turns · 18420 tokens · 37s
    ✓ read packages/subagent/src/view/tool-result-lines.ts · 0s
    ✓ grep "formatRunSessionLine" in packages/subagent/src · 1s
    ⠋ bash npm test --workspace=@pi9/subagent · 12s
```

- The main row no longer carries a `tool:<name>` segment; recent tools render as their own lines.
- Each tool line is `<status-glyph> <tool-name>[ <input-summary>] · <elapsed>`, where the glyph mirrors the status vocabulary (spinner for running, `✓` completed, `✗` errored) and elapsed runs from the tool's start to its completion or to now.
- Tool lines are chronological with the newest at the bottom.
- If a child's currently running tool is itself `subagent`, only that active `subagent` line is shown for that row; its nested child subagents still render normally as a depth-indented tree under the parent.

### Expanded rendering

Expanded output begins with the same main row, then the prompt, then the full chronological tool history (one line per call) instead of aggregate counts, then the result/error snippet for terminal rows:

```text
  ⠋ reviewer  auth review · 2 turns · 18420 tokens · 37s

    Review the auth changes and summarize risks.

    Tools:
      ✓ read packages/subagent/src/view/tool-result-lines.ts · 0s
      ✓ bash npm test --workspace=@pi9/subagent · 3s
      ⠋ edit packages/subagent/src/view/session-lines.ts · 4s
```

- Every tool call for the current run is listed, not just the three most recent, using the same line format as collapsed mode.

### Resumed-run sections

For a resumed subagent, expanded rendering shows each previous run as its own clearly marked section above the current run, in the same prompt/tools/output-or-error shape:

```text
  Previous run 1 · completed · 42s

    Previous prompt: start the review.

    Tools:
      ✓ read packages/subagent/src/domain/agent.ts · 1s
      ✓ bash npm test --workspace=@pi9/subagent · 12s

    Result: previous output snippet

  Current run …
```

- Multiple resumes accumulate multiple previous run sections in chronological order above the current run.
- Each section keeps its own prompt, isolated tool history, and output/error snippet; the current run's tool history never mixes in previous-run tools.
- Previous run sections render only in expanded mode — collapsed output and the final `results` view never show them.

### Tool input summaries

Tool lines surface useful details derived from the tool's arguments when available:

| Tool | Summary |
| --- | --- |
| `read` | path, plus `offset`/`limit` when present |
| `write`, `ls` | path |
| `edit` | path and edit count |
| `bash` | command, compacted to one line |
| `grep`, `find` | pattern and `in <path>` when present |
| `subagent` | action and task/session count |
| other tools | a compact, safe fallback from scalar args, or no summary |

### General

- Multi-task runs keep input order in final results and group related child rows together.
- Recursive subagent trees render as a depth-indented tree under their parent row, ordered by child `createdAt` within each parent.
- Mixed child failures mark the overall tool result as `isError` while preserving successful child results.

Renderer failures fall back to simple text/JSON output instead of breaking the tool call.

## Progress widget and settings

The extension also updates a lightweight widget outside the tool row.

- The widget appears while there are active sessions or retained resumable sessions.
- It auto-hides when there are no active or retained sessions.
- Each visible session renders as its own compact session line; nested children appear under their parent with depth-based indentation, preserving the recursive tree shape.
- Retained sessions are included when `display.widgetShowRetainedSessions` is true (the default).

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
    "defaultResumable": false,
    "backgroundNotify": "auto"
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

`runtime.backgroundNotify` controls how the parent agent is told a background subagent finished:

| Value | Behavior |
| --- | --- |
| `auto` | Coalesce background completion metadata and deliver it as a new parent turn once the parent is idle (default; least interrupting). |
| `steer` | Inject a steering-style notification into the parent's currently active run. If the parent is idle, fall back to starting a new parent turn. Delivery happens before a future model step, not necessarily before the currently-starting tool executes. |
| `none` | Do not notify. The parent must call `subagent list` or `subagent results` to discover completions. |

Notifications carry only metadata (session ids, agent, label, terminal status, elapsed time) and direct the parent to call `subagent results` for actual output. Multiple completions between dispatch events coalesce into one message.

## `/subagents` command

Run `/subagents` to inspect and manage subagents from the UI.

When active or retained sessions exist, `/subagents` opens the Sessions view. From there you can:

- Inspect a session's status, agent metadata, prompt preview, progress counters, timestamps, usage, output/error snippets, and available actions.
- Resume a completed resumable session, or a retryable resume attempt that failed before re-attaching to its retained session. The command asks for a follow-up prompt in an editor, runs with a cancellable loader, updates the widget live, and appends a concise custom result message to the main conversation. Cancelling the loader interrupts the child run instead of hiding background work.
- Remove a retained non-running resumable session.

If no active or retained sessions exist, `/subagents` opens the read-only Agents browser instead. The browser lists discovered user/project agent definitions and lets you inspect model, thinking, tools, resumable status, and source path metadata. It does not launch agents.

Run `/subagents settings` to open the Settings view directly.

## Background subagents

Background dispatch lets a `run` batch return immediately so the parent agent can continue working while children execute. Pass batch-level `background: true` on `action: "run"`.

Lifecycle:

1. The tool call returns immediately with `view: "background-started"` and the initial session views.
2. Children run under a manager-owned `AbortController` and are not bound to the parent tool-call signal — completing the parent tool call does not cancel them.
3. Background sessions appear in `subagent list` with `dispatch: "background"` and the appropriate `status`.
4. When a background session finishes, it is retained until removed or collected with `subagent results` (`{ remove: true }`) or `subagent remove`.

`dispatch`, `retention`, and `resumable` are independent:

- `dispatch: "foreground"` sessions are `retention: "persistent"` only when `resumable: true` (the resumable session is kept for the current Pi process). Otherwise they are `retention: "transient"` and pruned at completion.
- `dispatch: "background"` sessions are always `retention: "persistent"`, regardless of resumability — a non-resumable background job's result stays visible until it is removed or collected.

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
- `status: "completed"` resumable sessions can be resumed. A resume attempt that fails before re-attaching to the retained session is also retryable because the retained SDK session is untouched. Post-attach failed, aborted, and interrupted resumable sessions are inspect/remove-only.
- Command-driven resume messages include bounded metadata plus output/error snippets, not the full child transcript.

## Child session extensions

Each subagent child session discovers enabled extension paths through Pi's `DefaultPackageManager`, matching Pi's normal resolver for the child's working directory. This includes auto-discovered extensions, `settings.json` extension entries, and package manifest entries that Pi enables for that child session.

Imported factory functions are cached process-wide and reused across child sessions, but each child still receives fresh Pi `Extension` registrations. If the cache cannot import an entry (for example, an unusual package alias), it transparently falls back to Pi's path-based loader for that single entry; the fallback shows up in `PI_SUBAGENT_DEBUG_TIMING` logs and requires no action.

Constraints:

- Project discovery is based on the child's resolved working directory.
- Cached factories appear with inline source metadata in child sessions.
- The cache stores imported factory functions, not instantiated `Extension` objects, so each child gets fresh registrations.
- Because the imported module is reused, module-level state inside an extension can be shared across child sessions. Extensions that need per-session module isolation must avoid module-level mutable state.

Troubleshooting: if an extension behaves differently inside a subagent than at top level, set `PI_SUBAGENT_BYPASS_EXTENSION_CACHE=1` to route every entry through Pi's path-based loader. If behavior changes under bypass, file an issue with the extension name and what differed.

## Status meanings

Tool results and UI session rows use these terminal states:

| Status | Meaning | Resume? |
| --- | --- | --- |
| `completed` | The child run finished and returned output. | Yes, if `resumable: true`. |
| `error` | The agent was unknown, failed before running, or the child session failed without cancellation semantics. | Yes only for a retained resume attempt that failed before re-attaching; otherwise no. |
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

Tool results preserve input order. The model-facing text content is a list of
`BackgroundResult` entries (see [`action: "results"`](#action-results)); the in-process
`details.results` carries the terminal/live snapshots those entries are projected from, which is
what the renderer and HTML export consume. `action: "run"` and `action: "results"` share this
envelope. A synchronous run blocks until every task settles, so every entry is
`{ ready: true, result, sessionId? }`; `sessionId` is present only when the result is
resumable/collectable. Each `result` is projected from the task's terminal snapshot by the single
`toResult` projection — the done-state snapshot is the source of truth, and `result` is its
model-facing view.

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
    },
    {
      sessionId: "...",
      ready: true,
      result: {
        agent: "missing",
        prompt: "...",
        status: "error",
        error: "Unknown agent: missing. Available agents: ...",
        resumable: false,
        resumed: false,
        turns: 0,
        tokens: 0,
        elapsedMs: 0
      }
    }
  ]
}
```

Each `result` carries:

- `output` / `error`: the child's **full, untruncated** text (`output` for `completed`, `error`
  otherwise). Only the TUI compacts them; the structured result keeps everything.
- `resumed`: `true` if this task continued an existing session, `false` for a fresh spawn (and for tasks that errored before attaching to a session).
- `resumable`: `true` only when a child `AgentSession` exists or existed and the effective `resumable` flag is on.
- `sessionId`: present only when `resumable` is true.
- `label`: present when the task or a prior invocation supplied one.
- `turns`: assistant turns the child took.
- `tokens`: total tokens the child consumed.
- `elapsedMs`: wall-clock run duration (`0` for tasks that failed before starting).

The overall tool result is flagged as an error (`isError`) when any task has a non-`completed` status. Unknown agents, unknown sessionIds, and child-session failures are reported as failed per-task results without discarding other scheduled results.

## Limits and current constraints

- `action` is required; legacy `{ tasks: [...] }` calls and the previous `start`/`resume`/`clear` actions are rejected.
- Maximum tasks per `run` tool call defaults to eight and can be changed with `runtime.maxTasksPerRun`.
- Maximum concurrent child sessions defaults to four and can be changed with `runtime.maxConcurrentSubagents`. The cap applies tree-wide across all parent/child levels — a single shared queue owns the entire subagent tree.
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
