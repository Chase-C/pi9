import { describe, expect, it } from "vitest";
import {
  beginReminderAgentRun,
  consumeDueReminder,
  createReminderCadenceState,
  noteReminderTurn,
  noteTodoInteraction,
  type ReminderCadenceConfig,
} from "../src/reminder-cadence.js";

const config: ReminderCadenceConfig = {
  minTurns: 2,
  maxTurns: 4,
  outputTokens: 100,
  maxPerRun: 2,
};

describe("reminder cadence", () => {
  it("fires at the output-token boundary only after the minimum turn guard", () => {
    let state = createReminderCadenceState();
    state = noteReminderTurn(state, 100);
    expect(consumeDueReminder(state, config)).toEqual({ due: false, state });

    state = noteReminderTurn(state, 0);
    expect(consumeDueReminder(state, config)).toEqual({
      due: true,
      state: { turns: 0, outputTokens: 0, remindersThisRun: 1 },
    });
  });

  it("fires at the maximum-turn boundary without reaching the token threshold", () => {
    let state = createReminderCadenceState();
    for (let turn = 0; turn < 3; turn += 1) state = noteReminderTurn(state, 1);
    expect(consumeDueReminder(state, config)).toEqual({ due: false, state });

    state = noteReminderTurn(state, 1);
    expect(consumeDueReminder(state, config).due).toBe(true);
  });

  it("resets the cadence window after a successful todo interaction", () => {
    let state = createReminderCadenceState();
    state = noteReminderTurn(noteReminderTurn(state, 60), 40);
    state = noteTodoInteraction(state);

    expect(state).toEqual({ turns: 0, outputTokens: 0, remindersThisRun: 0 });
    expect(consumeDueReminder(state, config).due).toBe(false);
  });

  it("consumes reminders atomically and permits a repeat after a fresh window", () => {
    let state = noteReminderTurn(noteReminderTurn(createReminderCadenceState(), 50), 50);
    const first = consumeDueReminder(state, config);
    expect(first.due).toBe(true);
    expect(consumeDueReminder(first.state, config).due).toBe(false);

    state = noteReminderTurn(noteReminderTurn(first.state, 50), 50);
    expect(consumeDueReminder(state, config)).toEqual({
      due: true,
      state: { turns: 0, outputTokens: 0, remindersThisRun: 2 },
    });
  });

  it("does not fire above the per-agent-run cap", () => {
    const capped = { turns: 4, outputTokens: 100, remindersThisRun: 2 };
    expect(consumeDueReminder(capped, config)).toEqual({ due: false, state: capped });
  });

  it("resets only the cap count for a new agent run and preserves staleness", () => {
    const staleAndCapped = { turns: 4, outputTokens: 100, remindersThisRun: 2 };
    const nextRun = beginReminderAgentRun(staleAndCapped);

    expect(nextRun).toEqual({ turns: 4, outputTokens: 100, remindersThisRun: 0 });
    expect(consumeDueReminder(nextRun, config).due).toBe(true);
  });

  it("fully resets cadence state for a new session or branch", () => {
    expect(createReminderCadenceState()).toEqual({
      turns: 0,
      outputTokens: 0,
      remindersThisRun: 0,
    });
  });

  it("treats missing or invalid output-token usage as zero", () => {
    let state = noteReminderTurn(createReminderCadenceState());
    state = noteReminderTurn(state, -10);
    state = noteReminderTurn(state, Number.NaN);

    expect(state).toEqual({ turns: 3, outputTokens: 0, remindersThisRun: 0 });
  });
});
