import { TODO_ACTIONS, TODO_STATUSES, type TodoAction, type TodoPhase, type TodoPhaseInput, type TodoState, type TodoStatus, type TodoTransitionInput } from "./types.js";

export function createTodoState(): TodoState {
  return { phases: [] };
}

export function cloneTodoState(state: TodoState): TodoState {
  return {
    phases: state.phases.map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.map((task) => ({ ...task })),
    })),
  };
}

/** Applies an action atomically without mutating the supplied state or action. */
export function transitionTodoState(state: TodoState, action: TodoAction | unknown): TodoState {
  assertState(state);
  const input = record(action, "Todo action");
  const actionName = input.action;
  if (typeof actionName !== "string" || !(TODO_ACTIONS as readonly string[]).includes(actionName)) {
    throw new Error(`Todo action must be one of: ${TODO_ACTIONS.join(", ")}.`);
  }

  const next = cloneTodoState(state);
  switch (actionName) {
    case "set":
      assertOnlyFields(input, ["action", "phases"], "set");
      next.phases = parsePhases(input.phases).map(newPhase);
      break;
    case "add":
      assertOnlyFields(input, ["action", "phases"], "add");
      addPhases(next, parsePhases(input.phases));
      break;
    case "transition":
      assertOnlyFields(input, ["action", "transitions"], "transition");
      applyTransitions(next, parseTransitions(input.transitions));
      break;
    case "view":
      assertOnlyFields(input, ["action", "phase"], "view");
      if (input.phase !== undefined) next.phases = [findPhase(next.phases, name(input.phase, "view phase"))];
      break;
  }

  assertState(next);
  return next;
}

export const applyTodoAction = transitionTodoState;

function newPhase(input: TodoPhaseInput): TodoPhase {
  return { name: input.name, tasks: input.tasks.map((task) => ({ name: task, status: "pending" })) };
}

function addPhases(state: TodoState, inputs: TodoPhaseInput[]): void {
  if (!inputs.some((phase) => phase.tasks.length > 0)) {
    throw new Error("add requires at least one task.");
  }

  for (const input of inputs) {
    let phase = state.phases.find((candidate) => candidate.name === input.name);
    if (!phase) {
      phase = { name: input.name, tasks: [] };
      state.phases.push(phase);
    }
    const names = new Set(phase.tasks.map((task) => task.name));
    for (const task of input.tasks) {
      if (names.has(task)) throw new Error(`Duplicate task name in phase ${input.name}: ${task}.`);
      names.add(task);
      phase.tasks.push({ name: task, status: "pending" });
    }
  }
}

function applyTransitions(state: TodoState, transitions: TodoTransitionInput[]): void {
  if (transitions.length === 0) throw new Error("transition requires at least one status change.");
  const addressed = new Set<string>();

  for (const transition of transitions) {
    const key = addressKey(transition.phase, transition.task);
    if (addressed.has(key)) throw new Error(`Task may only be transitioned once per call: ${transition.phase} / ${transition.task}.`);
    addressed.add(key);

    const phase = state.phases.find((candidate) => candidate.name === transition.phase);
    if (!phase) throw new Error(phaseNotFoundMessage(state.phases, transition.phase));
    const task = phase.tasks.find((candidate) => candidate.name === transition.task);
    if (!task) throw new Error(taskNotFoundMessage(phase, transition.task));
    task.status = transition.status;
  }
}

function parsePhases(value: unknown): TodoPhaseInput[] {
  if (!Array.isArray(value)) throw new Error("phases must be an array.");
  const phases = value.map((item, phaseIndex) => {
    const input = record(item, `phases[${phaseIndex}]`);
    assertOnlyFields(input, ["name", "tasks"], `phases[${phaseIndex}]`);
    const phaseName = name(input.name, `phases[${phaseIndex}].name`);
    if (!Array.isArray(input.tasks)) throw new Error(`phases[${phaseIndex}].tasks must be an array.`);
    const tasks = input.tasks.map((task, taskIndex) => name(task, `phases[${phaseIndex}].tasks[${taskIndex}]`));
    assertUnique(tasks, (task) => `Duplicate task name in phase ${phaseName}: ${task}.`);
    return { name: phaseName, tasks };
  });
  assertUnique(phases.map((phase) => phase.name), (phase) => `Duplicate phase name: ${phase}.`);
  return phases;
}

function parseTransitions(value: unknown): TodoTransitionInput[] {
  if (!Array.isArray(value)) throw new Error("transitions must be an array.");
  return value.map((item, index) => {
    const input = record(item, `transitions[${index}]`);
    assertOnlyFields(input, ["phase", "task", "status"], `transitions[${index}]`);
    return {
      phase: name(input.phase, `transitions[${index}].phase`),
      task: name(input.task, `transitions[${index}].task`),
      status: status(input.status, `transitions[${index}].status`),
    };
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  if (value !== value.trim()) throw new Error(`${label} must not have leading or trailing whitespace.`);
  return value;
}

function status(value: unknown, label: string): TodoStatus {
  if (typeof value !== "string" || !(TODO_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of: ${TODO_STATUSES.join(", ")}.`);
  }
  return value as TodoStatus;
}

function assertOnlyFields(input: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} does not accept field: ${unexpected}.`);
}

function assertUnique(values: string[], message: (value: string) => string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(message(value));
    seen.add(value);
  }
}

function findPhase(phases: TodoPhase[], phaseName: string): TodoPhase {
  const phase = phases.find((candidate) => candidate.name === phaseName);
  if (!phase) throw new Error(phaseNotFoundMessage(phases, phaseName));
  return phase;
}

function phaseNotFoundMessage(phases: TodoPhase[], phaseName: string): string {
  const names = phases.map((phase) => `- ${phase.name}`).join("\n");
  return names ? `Phase not found: ${phaseName}.\n\nCurrent phases:\n${names}` : `Phase not found: ${phaseName}. The todo plan is empty.`;
}

function taskNotFoundMessage(phase: TodoPhase, taskName: string): string {
  const names = phase.tasks.map((task) => `- ${task.name}`).join("\n");
  return names
    ? `Task not found: ${phase.name} / ${taskName}.\n\nCurrent tasks in ${phase.name}:\n${names}`
    : `Task not found: ${phase.name} / ${taskName}. Phase ${phase.name} has no tasks.`;
}

export function todoAddressKey(phase: string, task: string): string {
  return addressKey(phase, task);
}

function addressKey(phase: string, task: string): string {
  return `${phase}\0${task}`;
}

function assertState(state: TodoState): void {
  if (!state || typeof state !== "object" || !Array.isArray(state.phases)) throw new Error("Invalid todo state.");
  const phaseNames = new Set<string>();
  let activePhase: string | undefined;

  for (const phase of state.phases) {
    if (!phase || typeof phase !== "object" || !Array.isArray(phase.tasks)) throw new Error("Invalid todo state.");
    const phaseName = name(phase.name, "phase name");
    if (phaseNames.has(phaseName)) throw new Error("Invalid todo state: duplicate phase name.");
    phaseNames.add(phaseName);

    const taskNames = new Set<string>();
    for (const task of phase.tasks) {
      if (!task || typeof task !== "object") throw new Error("Invalid todo state.");
      const taskName = name(task.name, "task name");
      if (taskNames.has(taskName)) throw new Error("Invalid todo state: duplicate task name.");
      if (!(TODO_STATUSES as readonly string[]).includes(task.status)) throw new Error("Invalid todo state.");
      if (task.status === "in_progress") {
        if (activePhase !== undefined && activePhase !== phaseName) {
          throw new Error("Invalid todo state: in_progress tasks must all belong to one phase.");
        }
        activePhase = phaseName;
      }
      taskNames.add(taskName);
    }
  }
}
