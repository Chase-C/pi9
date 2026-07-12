# @pi9/ask

Pi extension that registers a sequential `ask` tool for one focused question. It supports described options, single or multiple selection, per-option comments, and freeform responses.

## Install

```bash
pi install npm:@pi9/ask
```

For local development:

```bash
pi -e packages/ask/src/index.ts
```

## Tool input

```json
{
  "question": "Which deployment target should I use?",
  "context": "Both targets pass the current test suite.",
  "options": [
    { "label": "Staging", "description": "Validate internally first" },
    { "label": "Production", "description": "Release immediately" }
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```

Input is trimmed and validated. In TUI mode, selecting an assistant entry containing one standalone `ask` call in `/tree` opens a blank copy of the original questionnaire. A submitted revision is stored as a durable `ask:reanswer` custom message and immediately continues the agent; Escape cancels without adding a message or triggering a turn. Branch-summary selections resolve their immediate original parent. Mixed-tool, multiple-ask, and invalid Ask entries cannot be replayed; unrelated entries are ignored.

## TUI controls

The TUI uses a full-screen overlay:

- **↑/↓** or **j/k**: move between options
- **Space**: toggle an option in multiple-selection mode
- **Enter**: choose a single option, submit multiple selections, or edit freeform
- **c**: add or edit a comment for the highlighted option
- **Escape**: discard the current editor draft; from the option list, cancel
- **Ctrl+C**: cancel from an editor

## RPC and unavailable UI

RPC mode falls back to Pi's `select` and `input` dialogs. Multiple selection uses comma-separated option numbers and comments are collected in separate dialogs; it cannot provide the rich overlay's live checkbox and comment preview. Cancelling any dialog cancels the question. Modes without dialog-capable UI return a structured `ui_unavailable` result rather than throwing.

## Context behavior

Before each model request, completed ask calls are copied and pruned to the selected options, comments, and freeform answer. This reduces context use without mutating stored session entries. Cancelled and unavailable questionnaires are left intact.

Re-answers are not native tool reruns and do not create a second tool result in session history. They use a rendered `ask:reanswer` custom message containing the revised answer. The context hook validates that marker against the original tool call and projects it as a synthetic tool result for the model. A canonical native result takes precedence, and malformed, ambiguous, or unmatched replay markers are left unchanged. Replay is available only in the TUI and only for a single standalone Ask tool call.

## Development

```bash
npm run typecheck
npm test
```
