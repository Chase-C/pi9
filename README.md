# Pi9

Pi9 is a collection of extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Packages

- [`@pi9/subagent`](./packages/subagent) — resumable, background, and recursive subagents with live progress and tree-wide concurrency limits.
- [`@pi9/whisper`](./packages/whisper) — local agent-to-agent communication.

## Development

```bash
npm install
npm run check
npm run build
```

Run a command for one package with npm's workspace flag:

```bash
npm test --workspace @pi9/subagent
npm test --workspace @pi9/whisper
```
