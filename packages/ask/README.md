# @pi9/ask

Ask adds interactive questions to [Pi](https://github.com/earendil-works/pi-mono), turning moments when Pi needs your input into clear, keyboard-driven choices with descriptions, previews, comments, and freeform responses.

## Feature overview

- **Answer revisions** — Reopen an Ask entry from `/tree` and continue with a new answer.
- **Lean tool definition** — A highly optimized description and schema minimize prompt overhead while staying compatible across providers.
- **Rich previews** — Inspect Markdown previews before choosing.
- **Multi-select** — Choose any number of options, then submit them together.
- **Comments and custom responses** — Add context to a choice or write your own response.
- **Responsive layout** — Use side-by-side previews on wide terminals and stacked, scrollable content in smaller ones.
- **Keyboard-first controls** — Navigate with Pi keybindings or familiar **j/k** shortcuts.
- **Timeouts and RPC support** — Set response deadlines and answer through either the TUI or an RPC client.

## Install

```bash
pi install npm:@pi9/ask
```

## In action

### Make a quick choice

Choose from a focused list and see your answer directly in the conversation.

![A single-choice question with Developer tools selected and the answer shown inline](media/single-select.png)

### Preview the result

Options can include Markdown previews, making it easy to compare proposed output before deciding.

![A project picker showing a live CLI task tracker preview beside the options](media/option-preview.png)

### Select more than one

Multi-select questions combine checkboxes, descriptions, previews, optional freeform input, and an explicit Submit action.

![A multi-select productivity app question with three features selected and a notes preview](media/multi-select.png)

### Revise an earlier answer

Open an Ask entry from `/tree` to answer it again and continue the conversation from your revised choice.

![A Pi session tree showing several revised answers to the same favorite-season question](media/replay.png)

## Controls

Ask temporarily replaces the editor with a question. It follows your configured Pi selection keybindings and also supports **j/k** for navigation.

| Key | Action |
| --- | --- |
| **↑/↓** or **j/k** | Move between options |
| **Enter** or **Space** | Select an option, toggle a checkbox, or activate the highlighted response or Submit row |
| **c** | Add or edit a comment on the highlighted option |
| **Escape** | Discard the current draft, or cancel from the option list |
| **Ctrl+C** | Cancel from anywhere |

Comments let you qualify a selection without writing a separate message. When a question allows a custom response, highlight **Type a response…** and press **Enter** or **Space** to open the editor.

## Advanced behavior

### Responsive previews

Previews appear beside the options in terminals at least 88 columns wide and stack below them in narrower layouts. They support Markdown and update as you move between options. While you edit a comment or freeform response, the preview is hidden to leave more room for writing.

### Long questions

Ask adapts to the available terminal height rather than growing beyond the screen. When content overflows, `↑`, `↓`, and `↕` indicators show that more is available above, below, or in both directions. **Page Up** and **Page Down** move through longer lists quickly.

### Revising answers from `/tree`

In TUI mode, select a standalone Ask entry in `/tree` to reopen the original question, including its descriptions and previews. Submitting a new answer updates that entry and immediately continues the conversation. Pressing **Escape** cancels the revision without changing anything.

Answers and revisions follow the active session branch, so alternate branches can retain different choices.

### Timeouts

Set `PI9_ASK_TIMEOUT_MS` to apply a default response deadline in milliseconds:

```bash
PI9_ASK_TIMEOUT_MS=30000 pi
```

Set it to `0` to disable the default timeout. A question-specific deadline takes precedence when present. The deadline covers the complete interaction, including comments and freeform editing; expiry is reported separately from cancellation.

### RPC mode

Ask also works in Pi's RPC mode through standard selection and input dialogs. Multi-select answers use comma-separated option numbers, and comments are collected in follow-up dialogs. The richer live checkbox and preview interface is available only in the TUI.

Ask requires an interactive TUI or RPC client and remains inactive when no user interface is available.
