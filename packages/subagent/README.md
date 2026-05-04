# @pi9/subagent

A starter Pi extension that registers a `subagent` tool. The tool delegates work to a fresh `pi --mode json -p --no-session` subprocess, giving each subagent an isolated context window.

## Install for local development

```bash
npm install
npm run build
pi install ./packages/subagent
```

For quick testing without installing:

```bash
npm run build
pi -e ./packages/subagent
```

After edits, run `npm run build` and `/reload` in Pi.

## Define agents

This package ships starter `scout`, `planner`, and `reviewer` agents. Add your own markdown files in `~/.pi/agent/agents`:

```markdown
---
name: scout
description: Read-only codebase reconnaissance
tools: read, grep, find, ls, bash
---

You are a fast codebase scout. Inspect the repository and return concise, evidence-backed findings with file paths.
```

User agents override packaged agents with the same name. Project-local agents can live in `.pi/agents`; they are only loaded when the tool is called with `agentScope: "project"` or `"both"`, and override user/package agents.

## Use

List agents:

```text
/subagents
/subagents both
```

Single delegation:

```ts
subagent({ agent: "scout", task: "Find the auth entry points and summarize relevant files." })
```

Parallel delegation:

```ts
subagent({
  tasks: [
    { agent: "scout", task: "Map frontend auth code." },
    { agent: "scout", task: "Map backend auth code." }
  ]
})
```

Chain delegation:

```ts
subagent({
  chain: [
    { agent: "scout", task: "Find relevant files for adding Redis caching." },
    { agent: "planner", task: "Create an implementation plan from this context:\n\n{previous}" }
  ]
})
```

## Agent frontmatter

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Runtime agent name |
| `description` | yes | Shown in `/subagents` and errors |
| `model` | no | Passed as `--model` |
| `tools` | no | Comma-separated tool list passed as `--tools` |

The markdown body is passed as an appended system prompt for the subagent.

## Notes

- Subagents run in separate Pi processes with no session history (`--no-session`).
- Default scope is user agents only for safety.
- Keep one writer by default. Use parallel mode mainly for read-only scouting/review.
