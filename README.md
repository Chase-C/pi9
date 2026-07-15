# Pi9

Pi9 is a collection of extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Packages

- [`@pi9/ask`](./packages/ask) — an interactive tool for asking the user focused questions.
- [`@pi9/context`](./packages/context) — an inline breakdown of current context-window usage.
- [`@pi9/subagent`](./packages/subagent) — resumable, background, and recursive subagents with live progress and tree-wide concurrency limits.
- [`@pi9/todo`](./packages/todo) — phased, session-aware task planning with immutable task names and atomic status transitions.
- [`@pi9/whisper`](./packages/whisper) — local agent-to-agent communication.

## Development

```bash
npm install
npm run check
npm run build
```

Run a command for one package with npm's workspace flag:

```bash
npm test --workspace @pi9/ask
npm test --workspace @pi9/context
npm test --workspace @pi9/subagent
npm test --workspace @pi9/todo
npm test --workspace @pi9/whisper
```
