import {
  TODO_ACTIONS,
  TODO_STATUSES,
  isTodoActionName,
  isTodoStatus,
  type TodoAction,
  type TodoActionName,
  type TodoPhase,
  type TodoPhaseInput,
  type TodoState,
  type TodoStatus,
  type TodoTransitionInput,
} from "./types.js";

export function createTodoState(): TodoState {
  return { phases: [] };
}

export function cloneTodoState(state: TodoState): TodoState {
  return {
    phases: state.phases.map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.map((task) => ({ ...task })),
    })),
    ...(state.workingOn === undefined ? {} : { workingOn: state.workingOn }),
  };
}

/** Applies an action atomically without mutating the supplied state or action. */
export function transitionTodoState(state: TodoState, value: unknown): TodoState {
  assertTodoState(state);
  const action = parseTodoAction(value);

  let next: TodoState;
  switch (action.action) {
    case "set":
      next = { phases: action.phases.map(newPhase) };
      break;
    case "add":
      next = addPhases(state, action.phases);
      break;
    case "transition":
      next = applyTransitions(state, action.transitions, action.workingOn);
      break;
    case "view":
      next = state;
      break;
  }

  assertTodoState(next);
  return next;
}

function newPhase(input: TodoPhaseInput): TodoPhase {
  return {
    name: input.name,
    tasks: input.tasks.map((task) => ({ ...task, status: "pending" })),
  };
}

function addPhases(state: TodoState, inputs: readonly TodoPhaseInput[]): TodoState {
  const existingPhases = new Map(state.phases.map((phase) => [phase.name, phase]));
  for (const input of inputs) {
    const phase = existingPhases.get(input.name);
    if (!phase) continue;

    const taskNames = new Set(phase.tasks.map((task) => task.name));
    for (const task of input.tasks) {
      if (taskNames.has(task.name)) throw new Error(`Duplicate task name in phase ${input.name}: ${task.name}.`);
      taskNames.add(task.name);
    }
  }

  const additions = new Map(inputs.map((phase) => [phase.name, phase.tasks]));
  const phases = state.phases.map((phase) => {
    const tasks = additions.get(phase.name);
    return !tasks
      ? phase
      : { ...phase, tasks: [...phase.tasks, ...tasks.map((task) => ({ ...task, status: "pending" as const }))] };
  });

  for (const input of inputs) {
    if (!existingPhases.has(input.name)) phases.push(newPhase(input));
  }
  return { ...state, phases };
}

function applyTransitions(
  state: TodoState,
  transitions: readonly TodoTransitionInput[],
  workingOn: string | undefined,
): TodoState {
  if (transitions.length === 0) throw new Error("transition requires at least one status change.");

  const statuses = new Map<string, TodoStatus>();
  for (const transition of transitions) {
    const key = todoAddressKey(transition.phase, transition.task);
    if (statuses.has(key)) {
      throw new Error(`Task may only be transitioned once per call: ${transition.phase} / ${transition.task}.`);
    }

    const phase = state.phases.find((candidate) => candidate.name === transition.phase);
    if (!phase) throw new Error(phaseNotFoundMessage(state.phases, transition.phase));
    if (!phase.tasks.some((candidate) => candidate.name === transition.task)) {
      throw new Error(taskNotFoundMessage(phase, transition.task));
    }
    statuses.set(key, transition.status);
  }

  const phases = state.phases.map((phase) => ({
    ...phase,
    tasks: phase.tasks.map((task) => {
      const status = statuses.get(todoAddressKey(phase.name, task.name));
      return status === undefined ? task : { ...task, status };
    }),
  }));
  const hasActiveTasks = phases.some((phase) => phase.tasks.some((task) => task.status === "in_progress"));
  if (!hasActiveTasks) return { phases };
  if (workingOn === undefined) {
    throw new Error("transition requires workingOn when tasks remain in_progress.");
  }
  return { phases, workingOn };
}

function parseTodoAction(value: unknown): TodoAction {
  const input = record(value, "Todo action");
  const action = actionName(input.action);

  switch (action) {
    case "set":
    case "add":
      assertOnlyFields(input, ["action", "phases"], action);
      return { action, phases: parsePhases(input.phases) };
    case "transition":
      assertOnlyFields(input, ["action", "transitions", "workingOn"], action);
      return {
        action,
        transitions: parseTransitions(input.transitions),
        ...(input.workingOn === undefined
          ? {}
          : { workingOn: name(input.workingOn, "transition workingOn") }),
      };
    case "view":
      assertOnlyFields(input, ["action"], action);
      return { action };
  }
}

function parsePhases(value: unknown): TodoPhaseInput[] {
  if (!Array.isArray(value)) throw new Error("phases must be an array.");
  if (value.length === 0) throw new Error("phases must contain at least one phase.");
  const phases = value.map((item, phaseIndex) => {
    const input = record(item, `phases[${phaseIndex}]`);
    assertOnlyFields(input, ["name", "tasks"], `phases[${phaseIndex}]`);
    const phaseName = name(input.name, `phases[${phaseIndex}].name`);
    if (!Array.isArray(input.tasks)) throw new Error(`phases[${phaseIndex}].tasks must be an array.`);
    if (input.tasks.length === 0) throw new Error(`phases[${phaseIndex}].tasks must contain at least one task.`);
    const tasks = input.tasks.map((task, taskIndex) => {
      const label = `phases[${phaseIndex}].tasks[${taskIndex}]`;
      const taskInput = record(task, label);
      assertOnlyFields(taskInput, ["name", "description"], label);
      return {
        name: name(taskInput.name, `${label}.name`),
        description: name(taskInput.description, `${label}.description`),
      };
    });
    assertUnique(tasks.map((task) => task.name), (task) => `Duplicate task name in phase ${phaseName}: ${task}.`);
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

function actionName(value: unknown): TodoActionName {
  if (!isTodoActionName(value)) throw new Error(`Todo action must be one of: ${TODO_ACTIONS.join(", ")}.`);
  return value;
}

function status(value: unknown, label: string): TodoStatus {
  if (!isTodoStatus(value)) throw new Error(`${label} must be one of: ${TODO_STATUSES.join(", ")}.`);
  return value;
}

function assertOnlyFields(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} does not accept field: ${unexpected}.`);
}

function assertUnique(values: readonly string[], message: (value: string) => string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(message(value));
    seen.add(value);
  }
}

function phaseNotFoundMessage(phases: readonly TodoPhase[], phaseName: string): string {
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
  return `${phase}\0${task}`;
}

export function currentTodoPhaseIndex(phases: readonly TodoPhase[]): number {
  const active = phases.findIndex((phase) => phase.tasks.some((task) => task.status === "in_progress"));
  return active >= 0
    ? active
    : phases.findIndex((phase) => phase.tasks.some((task) => task.status === "pending"));
}

export function isTodoState(value: unknown): value is TodoState {
  try {
    assertTodoState(value);
    return true;
  } catch {
    return false;
  }
}

function assertTodoState(value: unknown): asserts value is TodoState {
  if (!value || typeof value !== "object" || !Array.isArray((value as { phases?: unknown }).phases)) {
    throw new Error("Invalid todo state.");
  }

  const state = value as { phases: unknown[]; workingOn?: unknown };
  const workingOn = state.workingOn === undefined ? undefined : name(state.workingOn, "workingOn");
  const phaseNames = new Set<string>();
  let activePhase: string | undefined;

  for (const value of state.phases) {
    if (!value || typeof value !== "object" || !Array.isArray((value as { tasks?: unknown }).tasks)) {
      throw new Error("Invalid todo state.");
    }
    const phase = value as { name?: unknown; tasks: unknown[] };
    if (phase.tasks.length === 0) throw new Error("Invalid todo state: phases must contain at least one task.");
    const phaseName = name(phase.name, "phase name");
    if (phaseNames.has(phaseName)) throw new Error("Invalid todo state: duplicate phase name.");
    phaseNames.add(phaseName);

    const taskNames = new Set<string>();
    for (const value of phase.tasks) {
      if (!value || typeof value !== "object") throw new Error("Invalid todo state.");
      const task = value as { name?: unknown; description?: unknown; status?: unknown };
      const taskName = name(task.name, "task name");
      name(task.description, "task description");
      if (taskNames.has(taskName)) throw new Error("Invalid todo state: duplicate task name.");
      if (!isTodoStatus(task.status)) throw new Error("Invalid todo state.");
      if (task.status === "in_progress") {
        if (activePhase !== undefined && activePhase !== phaseName) {
          throw new Error(
            `Invalid todo state: in_progress tasks span conflicting phases: ${activePhase} and ${phaseName}.`,
          );
        }
        activePhase = phaseName;
      }
      taskNames.add(taskName);
    }
  }

  if (activePhase !== undefined && workingOn === undefined) {
    throw new Error("Invalid todo state: workingOn is required while tasks are in_progress.");
  }
  if (activePhase === undefined && workingOn !== undefined) {
    throw new Error("Invalid todo state: workingOn requires an in_progress task.");
  }
}
