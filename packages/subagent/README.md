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

- A `subagent` tool with `list`, `start`, `resume`, and `clear` actions.
- Live progress updates while child agents are queued or running.
- Custom collapsed/expanded rendering for `subagent` tool results.
- An auto-hidden widget for active and retained resumable sessions.
- A `/subagents` command with Sessions, Agents, and Settings views.
- Process-lifetime resumable sessions for agents that opt in with `resumable: true`.

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
| `resumable` | no | Boolean. Defaults to `false`. When `true`, sessions with a child `AgentSession` can be retained for this Pi process lifetime. Only completed resumable sessions can be resumed. |

The markdown body after the frontmatter is trimmed and used as the child session's system prompt.

## Use the tool

The tool accepts a required `action`.

List available agent definitions:

```ts
subagent({ action: "list" })
```

List active and retained sessions instead:

```ts
subagent({ action: "list", type: "sessions" })
```

Start one or more delegations with `action: "start"`. Each task names an agent and provides the prompt to send to that agent.

Single delegation:

```ts
subagent({
  action: "start",
  tasks: [
    { agent: "scout", prompt: "Find the auth entry points and summarize relevant files." }
  ]
})
```

Bounded multi-task delegation:

```ts
subagent({
  action: "start",
  tasks: [
    { agent: "scout", prompt: "Map frontend auth code and list key files." },
    { agent: "scout", prompt: "Map backend auth code and list key files." },
    { agent: "reviewer", prompt: "Review auth-related tests and summarize coverage gaps." }
  ]
})
```

Resume a completed retained run from an agent with `resumable: true`:

```ts
subagent({
  action: "resume",
  sessionId: "...",
  prompt: "Use your previous findings to propose the smallest implementation plan."
})
```

Clear sessions:

```ts
subagent({ action: "clear", sessionId: "..." }) // clear one known session; aborts it if still running
subagent({ action: "clear" })                   // clear all non-running retained sessions
```

The parent remains responsible for sequencing. If later work depends on earlier output, make one `subagent` call, inspect the result, then make the next call.

## Live tool rendering

`subagent start` and `subagent resume` stream live updates into the tool result while children run.

- Collapsed rendering shows an aggregate group line, such as task count, status counts, and overall outcome.
- Expanded rendering shows one row per child session with agent name, status, turn/tool counts, elapsed time, active tool, live message snippet, and final outcome.
- Multi-task starts keep input order in final results and group related child rows together.
- Mixed child failures mark the overall tool result as `isError` while preserving successful child results.

Renderer failures fall back to simple text/JSON output instead of breaking the tool call.

## Progress widget and settings

The extension also updates a lightweight widget outside the tool row.

- The widget appears while there are active sessions or retained resumable sessions.
- It auto-hides when there are no active or retained sessions.
- A single visible session renders a compact session line.
- Multiple visible sessions render a one-line summary of active and retained counts.

Configure placement with `/subagents settings`:

| Value | Behavior |
| --- | --- |
| `belowEditor` | Show the widget below the editor. This is the default. |
| `aboveEditor` | Show the widget above the editor. |
| `off` | Disable only the persistent widget. Tool rendering and `/subagents` still work. |

The setting is global for the user and is stored in the Pi agent directory.

## `/subagents` command

Run `/subagents` to inspect and manage subagents from the UI.

When active or retained sessions exist, `/subagents` opens the Sessions view. From there you can:

- Inspect a session's status, agent metadata, prompt preview, progress counters, timestamps, usage, output/error snippets, and available actions.
- Resume a completed resumable session. The command asks for a follow-up prompt in an editor, runs with a cancellable loader, updates the widget live, and appends a concise custom result message to the main conversation. Cancelling the loader interrupts the child run instead of hiding background work.
- Clear a retained non-running resumable session.

If no active or retained sessions exist, `/subagents` opens the read-only Agents browser instead. The browser lists discovered user/project agent definitions and lets you inspect model, thinking, tools, resumable status, and source path metadata. It does not launch agents.

Run `/subagents settings` to open the Settings view directly.

## Session lifetime and retention

Session management is intentionally process-lifetime only.

- Active queued/running sessions are visible while they exist.
- Resumable sessions with a child `AgentSession` are retained after completion or failure only for the current Pi extension process.
- Completed non-resumable sessions disappear from the session UI after the tool result settles.
- Restarting Pi or reloading the extension releases retained sessions; sessions are not restored from disk.
- `sessionId` identifies a retained process-local session, not a durable record.
- Tool results include `resumable` and include `sessionId` only when a resumable child has or had a child `AgentSession`. Check `resumable` and the status before offering follow-up behavior.
- Only `status: "completed"` resumable sessions can be resumed. Failed, aborted, and interrupted resumable sessions are inspect/clear-only.
- Command-driven resume messages include bounded metadata plus output/error snippets, not the full child transcript.

## Status meanings

Tool results and UI session rows use these terminal states:

| Status | Meaning | Resume? |
| --- | --- | --- |
| `completed` | The child run finished and returned output. | Yes, if `resumable: true`. |
| `error` | The agent was unknown, failed before running, or the child session failed without cancellation semantics. | No. |
| `aborted` | A running session was explicitly aborted, such as by clearing it directly through the tool API. | No. |
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
      prompt: "Map frontend auth code and list key files.",
      status: "completed",
      output: "...",
      model: "anthropic/claude-sonnet-4",
      resumable: true,
      sessionId: "..."
    },
    {
      agent: "missing",
      prompt: "...",
      status: "error",
      error: "Unknown agent: missing. Available agents: ..."
    }
  ],
  group: { /* live/final grouped UI DTO */ }
}
```

`isError` is set when any run has a non-`completed` status. Unknown agents and child-session failures are reported as failed per-run results without discarding other scheduled results.

## Limits and current constraints

- `action` is required; legacy `{ tasks: [...] }` calls are rejected.
- Maximum eight tasks per `start` tool call.
- Maximum four child sessions run concurrently.
- Agent discovery always checks user agents and the nearest project agents for the execution `cwd`; there is no `agentScope` parameter.
- No per-run timeout is exposed beyond parent abort/cancellation.
- Child sessions isolate Pi message history/context, but they still run inside the same extension process.
- Resumable sessions are retained only for the current Pi process lifetime and only for agents with `resumable: true`.

## MVP non-goals

The current UI is intentionally lightweight. It does not provide:

- Restart-resumable sessions after a Pi process restart.
- Branch-aware or project-aware durable session persistence.
- A manual launch wizard for starting agents from `/subagents`.
- Abort/retry controls from the `/subagents` UI.
- A full orchestration dashboard.
