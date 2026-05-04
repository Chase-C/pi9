# `@pi9/subagent` — Design

Working design notes for the package. This started as a snapshot of `0.1.0`; some sections may describe intended behavior rather than current code.

## 1. Purpose

`@pi9/subagent` registers one Pi tool, `subagent`, plus one slash command, `/subagents`.

The tool lets a parent Pi agent delegate work to short-lived child `AgentSession`s created with Pi's SDK. Each child gets its own message history and context window, then returns its final assistant text to the parent.

The package provides:

1. **Isolation** — noisy research, long reads, and speculative planning do not pollute the parent context.
2. **Specialization** — agents are markdown files with frontmatter (`name`, `description`, optional `tools`/`model`) and a body appended as system prompt.
3. **Composition** — a single call can run one task or a bounded batch. Sequencing remains the parent agent's responsibility.

## 2. Public surfaces

### `/subagents`

Lists discovered agents; it never executes them.

- Registered with `pi.registerCommand("subagents", …)`.
- Optional argument: `user`, `project`, or `both` (default `user`).
- Calls `discoverAgents(ctx.cwd, scope)` and reports the listing plus searched directories.
- Emits `info` when agents exist, otherwise `warning`.

### `subagent` tool

Registered with `pi.registerTool({ … })`.

| Param        | Type                                | Notes |
|--------------|-------------------------------------|-------|
| `tasks`      | `Array<{agent, prompt, cwd?}>`      | Required; length 1 is the common case |
| `agentScope` | `"user" \| "project" \| "both"?` | Discovery scope; default `user` |

Missing, empty, or oversized task lists return an error that includes the available agents.

Limits:

- `MAX_TASKS = 6`
- `MAX_CONCURRENCY = 3`

Prompt guidance tells the parent model to use subagents for isolated research, planning, review, or implementation tasks, and to prefer a single writer; multi-task batches are intended for read-only scouting/review.

## 3. Runtime behavior

### Discovery

Every tool call discovers agents before execution. Unknown agent names synthesize a failed `SubagentRun` with an available-agent listing.

### Child session setup

For each task, `runAgent` creates an in-memory SDK session instead of spawning `pi`:

1. Resolve `cwd` from the task override or parent `ctx.cwd`.
2. Build a `DefaultResourceLoader` for that `cwd` and append the agent body via `appendSystemPromptOverride`.
3. Resolve optional frontmatter:
   - `tools` becomes the SDK `tools` allowlist.
   - `model`, when present, is resolved through `ctx.modelRegistry` and passed as `model`.
4. Call `createAgentSession({ cwd, resourceLoader, modelRegistry: ctx.modelRegistry, model?, tools?, sessionManager: SessionManager.inMemory(cwd) })`.
5. Subscribe to session events for progress and final output.
6. Call `session.prompt(task.prompt, { source: "extension" })`.
7. Dispose the session in `finally`.

The resource loader keeps normal Pi discovery behavior for context files, skills, prompts, and extensions, with the agent prompt appended to the child system prompt.

### Output handling

- `message_update` text deltas update the live `SubagentRun.output`.
- After `session.prompt(...)` resolves, `session.getLastAssistantText()` becomes the final `run.output`.
- Errors thrown by setup or prompting mark the run as `failed` and become the output/error text.
- On parent abort, call `session.abort()` and mark the run failed or cancelled.

Each `SubagentRun` records `agent`, `prompt`, `status`, `output`, optional `error`, and optional `model`.

### Results

The tool runs `tasks` via `mapLimited(tasks, MAX_CONCURRENCY, …)`. Final content contains every run's full output under per-run headers. `details = { runs }`. `isError` is set if any run fails, but all scheduled runs are allowed to finish.

### Live updates

The tool calls `onUpdate?.(...)` with `summarizeRuns`, a truncated snapshot with `✓/✗/…` and the first six output lines per run.

Only live progress is truncated. Final returned content uses the full output.

## 4. Agent discovery

### Sources and precedence

Agents are merged into a `Map<name, AgentConfig>` in this order, so later sources override earlier ones:

1. **Package:** shipped `agents/` directory next to `dist/`.
2. **User:** `${PI_AGENT_DIR ?? ~/.pi/agent}/agents`, for scope `user` or `both`.
3. **Project:** nearest `.pi/agents` found by walking up from `cwd`, for scope `project` or `both`.

Default scope is `user`; project agents require explicit opt-in.

Returned configs include `source` (`package`, `user`, or `project`) and absolute `filePath` for diagnostics.

`summarizeAgents(agents)` returns alphabetized lines like `name (source) — description`, used by `/subagents` and error paths.

## 5. Agent file frontmatter

Agent files are `.md` files with `---` frontmatter followed by the agent prompt body.

Required fields:

- `name`: agent identifier used in tool calls.
- `description`: short summary shown in listings and error messages.

Optional fields:

- `model`: model to use for this agent, resolved through Pi's model registry.
- `tools`: comma-separated tool allowlist passed to the child session.

The body after the closing `---` is trimmed and appended to the child session's system prompt. Invalid or unreadable files are skipped.

The parser is intentionally small: line-oriented, first-colon split, strips simple quote wrapping, ignores `#` comment lines, and does not support arrays, nested keys, or multi-line values.

## 6. External assumptions

The package depends on these Pi SDK behaviors:

- `ExtensionAPI` exposes `registerTool` and `registerCommand`; tool `execute` receives `(toolCallId, params, signal, onUpdate, ctx)`.
- Tool `ctx` exposes `cwd`, `modelRegistry`, `model`, and an abort `signal` during tool execution.
- `@mariozechner/pi-coding-agent` exports `createAgentSession`, `DefaultResourceLoader`, and `SessionManager`.
- `createAgentSession` accepts `cwd`, `resourceLoader`, `modelRegistry`, `model`, `tools`, and `sessionManager` options.
- `SessionManager.inMemory(cwd)` creates an ephemeral session with no disk persistence.
- `AgentSession.prompt()` resolves after the child run is complete, and `getLastAssistantText()` returns the final assistant text.
- `AgentSession.subscribe()` emits `message_update` events with text deltas suitable for live progress.

## 7. Current constraints

- Scope defaults to `user`; project agents require opt-in.
- No per-run timeout beyond parent abort handling.
- No token/cost accounting is surfaced in the tool result.
- No upfront validation for `tools` or `model`; invalid values fail during child session setup or execution.
- Batch limits are hard-coded: six tasks, three concurrent children.
- SDK child sessions isolate message history but not the OS process; runaway JS, memory leaks, or extension side effects share the parent process.
- Child sessions load resources per run, so repeated batches may duplicate extension/resource initialization work.
- Malformed agent files are silently skipped.
- Project discovery loads only the nearest `.pi/agents` directory.
- `agentScope` is per-call; there is no extension-level configuration.

## 8. Decisions log

- **Drop `chain` mode.** Sequencing is the orchestrator's job; `{previous}` interpolation and stop-on-fail behavior made the tool larger without enough benefit.
- **Drop single dispatch mode.** All calls use `tasks: [{ agent, prompt, cwd? }]`; one-item batches cover the common case without a second parameter shape.
- **Use the Pi SDK for child runs.** `createAgentSession` avoids CLI subprocess management, temp prompt files, stdout JSON parsing, and stderr/exit-code bookkeeping.
- **Return full task outputs.** `run.output` is already the subagent's distilled answer, so final results preserve it. Truncation is only for live progress.
