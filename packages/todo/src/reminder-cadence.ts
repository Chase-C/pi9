export interface ReminderCadenceConfig {
  readonly minTurns: number;
  readonly maxTurns: number;
  readonly outputTokens: number;
  readonly maxPerRun: number;
}

export interface ReminderCadenceState {
  readonly turns: number;
  readonly outputTokens: number;
  readonly remindersThisRun: number;
}

export function createReminderCadenceState(): ReminderCadenceState {
  return { turns: 0, outputTokens: 0, remindersThisRun: 0 };
}

export function beginReminderAgentRun(state: ReminderCadenceState): ReminderCadenceState {
  return { ...state, remindersThisRun: 0 };
}

export function noteReminderTurn(
  state: ReminderCadenceState,
  outputTokens: number = 0,
): ReminderCadenceState {
  return {
    ...state,
    turns: state.turns + 1,
    outputTokens: state.outputTokens + validTokenCount(outputTokens),
  };
}

export function noteTodoInteraction(state: ReminderCadenceState): ReminderCadenceState {
  return { ...state, turns: 0, outputTokens: 0 };
}

export function consumeDueReminder(
  state: ReminderCadenceState,
  config: ReminderCadenceConfig,
): { due: boolean; state: ReminderCadenceState } {
  const minimumMet = state.turns >= config.minTurns;
  const triggerMet = state.turns >= config.maxTurns || state.outputTokens >= config.outputTokens;
  const belowCap = state.remindersThisRun < config.maxPerRun;

  if (!minimumMet || !triggerMet || !belowCap) return { due: false, state };

  return {
    due: true,
    state: {
      turns: 0,
      outputTokens: 0,
      remindersThisRun: state.remindersThisRun + 1,
    },
  };
}

function validTokenCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
