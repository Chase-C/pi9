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
- **Space**: toggle an option or freeform response in multiple-selection mode; activate Submit when highlighted
- **Enter**: choose a single option, toggle a multiple-selection option, edit freeform, or activate Submit when highlighted
- **c**: add or edit a comment for the highlighted option
- **Escape**: discard the current editor draft; from the option list, cancel
- **Ctrl+C**: cancel from an editor

## RPC and unavailable UI

RPC mode falls back to Pi's `select` and `input` dialogs. Multiple selection uses comma-separated option numbers and comments are collected in separate dialogs; it cannot provide the custom TUI's live checkbox and comment preview. Cancelling any dialog cancels the question. Modes without dialog-capable UI return a structured `ui_unavailable` result rather than throwing.

## Context behavior

Before each model request, completed standalone Ask exchanges are projected non-destructively as hidden `ask:summary` custom messages. Each summary contains compact JSON with `type: "ask_response"`, `question`, optional `context`, `selectionMode`, and an `answer` array of selected objects followed by an optional freeform response. Stored entries and the visible tool row remain unchanged; revisions use the latest answer.

Mixed-tool or multiple-Ask messages, invalid calls, and cancelled or unavailable results remain intact rather than being projected. Malformed, ambiguous, or unmatched entries are left unchanged. Replay is available only in the TUI and only for a single standalone Ask tool call.

## Development

```bash
npm run typecheck
npm test
```
