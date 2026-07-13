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

Input is trimmed and validated. In TUI mode, selecting the visible row for a standalone `ask` call in `/tree` opens a blank copy of the original questionnaire. A submitted revision is stored as a hidden, durable `ask:reanswer` marker, updates the original tool row, and immediately continues the agent; Escape cancels without adding a marker or triggering a turn. Branch-summary selections resolve their immediate original parent. Mixed-tool, multiple-ask, and invalid Ask entries cannot be replayed; unrelated entries are ignored.

## TUI controls

The TUI temporarily replaces the editor with a custom questionnaire:

- **↑/↓** or **j/k**: move between options
- **Space**: toggle an option in multiple-selection mode
- **Enter**: choose a single option, submit multiple selections, or edit freeform
- **c**: add or edit a comment for the highlighted option
- **Escape**: discard the current editor draft; from the option list, cancel
- **Ctrl+C**: cancel from an editor

## RPC and unavailable UI

RPC mode falls back to Pi's `select` and `input` dialogs. Multiple selection uses comma-separated option numbers and comments are collected in separate dialogs; it cannot provide the custom TUI's live checkbox and comment preview. Cancelling any dialog cancels the question. Modes without dialog-capable UI return a structured `ui_unavailable` result rather than throwing.

## Context behavior

Before each model request, completed ask calls are copied with their original options replaced by the schema-valid `answered` marker. The selected labels, descriptions, comments, and freeform answer remain in the result. This reduces context use without mutating stored session entries. Cancelled and unavailable questionnaires are left intact.

Re-answers are not native tool reruns and do not create a second tool result in session history. They use a hidden `ask:reanswer` marker containing the revised answer, while the original tool row renders the latest revision. The context hook validates that marker against the original tool call and projects it as the revised tool result for the model, reusing the native result retained when navigating to the visible tool row. Malformed, ambiguous, or unmatched replay markers are left unchanged. Replay is available only in the TUI and only for a single standalone Ask tool call.

## Development

```bash
npm run typecheck
npm test
```
