# @pi9/persona

Prompt-based agent personas for [Pi](https://github.com/badlogic/pi-mono). Switch behavioral instructions during a session without replacing Pi's normal tools, model, thinking level, or project context.

## Install

```bash
pi install npm:@pi9/persona
```

For local development, load `packages/persona/src/index.ts` as an extension.

## Configure

Create Markdown files in either personas directory:

- `~/.pi/agent/personas/` — available in every project
- `<project>/.pi/personas/` — loaded only when the project is trusted

Each file requires a `name`, may include a `description`, and uses its Markdown body as the persona instructions:

```markdown
---
name: planner
description: Explore the problem and plan before implementation
---

Act as a planner. Explore the problem, ask clarifying questions, and return a numbered implementation plan. Do not implement the plan.
```

Only `.md` files directly inside each directory are loaded. Persona names are case-sensitive. A project persona overrides a global persona with the same frontmatter name. Duplicate names within one directory produce a warning, with the alphabetically later filename taking precedence.

After adding or editing persona files, run `/reload`.

Personas are prompt-only. They do not change the model, thinking level, active tools, or tool permissions.

## Usage

Run `/persona` to choose from configured personas, or switch directly by name:

```text
/persona planner
```

Clear the active persona with any of:

```text
/persona none
/persona off
/persona clear
```

Cycle alphabetically through configured personas with:

- `Alt+]` — next persona
- `Alt+[` — previous persona

Cycling wraps at either end. When no persona is active, forward cycling selects the first persona and backward cycling selects the last.

The active persona appears in the status bar as `persona:<name>`. Selection is stored on the current session branch and restored when that branch is resumed or forked.

The agent can also use the `persona` tool:

- `list` — list configured personas and the active selection
- `set` — activate the exact, case-sensitive name supplied in `persona`
- `clear` — clear the active persona

Tool-based changes take effect on the next model response in the current run.

## Prompt behavior

If a persona is selected before the first conversation turn, the extension appends two sections to every system prompt:

1. Guidance explaining how persona changes work.
2. The current persona baseline and its instructions.

The selected persona becomes the initial baseline. Later switches are recorded as hidden `persona-change` messages, and the newest such message overrides the baseline.

Compaction creates a new context boundary. After compaction, the currently active persona becomes the new system-prompt baseline and earlier persona messages are no longer needed. If no persona is active at compaction, the persona sections are omitted. Later switches continue to use hidden messages until the next compaction.

If the first turn starts without an active persona, the system prompt remains unmodified. The first persona selected later is communicated through a hidden `persona-activation` message containing the persona-usage guidance and active instructions. Subsequent switches use hidden `persona-change` messages. The extension sends these messages during `before_agent_start`, so Pi persists them immediately before the pending user request rather than after it.

This ordering relies on Pi's current behavior for `sendMessage()` without `triggerTurn` while idle. Prompts queued while an agent run is already active do not emit `before_agent_start` and are not covered by this ordering guarantee.

## Development

```bash
npm run typecheck
npm test
```
