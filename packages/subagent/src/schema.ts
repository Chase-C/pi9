import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./agents.js";
import { isConversationId, type ConversationId } from "./identifiers.js";
import { isRunId, type RunId } from "./identifiers.js";

export { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./agents.js";

const NonBlankString = (description: string) =>
  Type.String({ minLength: 1, description });

export const TaskSchema = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent definition to `Spawn`." })),
  conversationId: Type.Optional(Type.String({ description: "Conversation to `Resume`." })),
  runId: Type.Optional(Type.String({ description: "Running subagent to `Steer`." })),
  prompt: NonBlankString("Instructions to send to the subagent."),
  label: Type.Optional(NonBlankString("3–5 plain words describing the task, for display; not an identifier.")),
  skills: Type.Optional(Type.Array(Type.String(), { description: "Skills override." })),
  model: Type.Optional(Type.String({ description: "Model override." })),
  thinking: Type.Optional(StringEnum(MODEL_THINKING_LEVELS, { description: "Thinking override." })),
  cwd: Type.Optional(Type.String({ description: "Working directory override." })),
}, { additionalProperties: false });

export const SUBAGENT_ACTIONS = ["agents", "list", "dispatch", "inspect", "join", "remove"] as const;
export const RUN_STATUSES = [
  "queued", "running", "completed", "error", "aborted", "interrupted", "skipped",
] as const;

export const SubagentParams = Type.Object({
  action: StringEnum(SUBAGENT_ACTIONS),
  status: Type.Optional(Type.Array(StringEnum(RUN_STATUSES), { minItems: 1 })),
  tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1 })),
  runIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  conversationIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
}, { additionalProperties: false });

export type SubagentParams = Static<typeof SubagentParams>;
export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);

export type SpawnRequest = {
  kind: "spawn";
  agent: string;
  prompt: string;
  label?: string;
  skills?: string[];
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
};

export type ResumeRequest = {
  kind: "resume";
  conversationId: ConversationId;
  prompt: string;
};

export type SteerRequest = {
  kind: "steer";
  runId: RunId;
  prompt: string;
};

export type TaskRequest = SpawnRequest | ResumeRequest | SteerRequest;
export type InspectTarget = RunId | { runId: string; error: string };
export type DispatchTaskKind = TaskRequest["kind"];
export type ParsedTask = TaskRequest | { error: string };

export type SubagentInvocation =
  | { action: "agents" }
  | { action: "list"; status?: RunStatus[] }
  | { action: "dispatch"; tasks: ParsedTask[] }
  | { action: "inspect"; runIds: InspectTarget[] }
  | { action: "join"; runIds: RunId[] }
  | { action: "remove"; conversationIds: ConversationId[] };

export type SubagentInvocationParseError = {
  error: string;
  action?: SubagentAction;
  missingAction?: boolean;
  taskCountError?: boolean;
};

export type ParsedSubagentInvocation =
  | SubagentInvocation
  | SubagentInvocationParseError;

export interface ParseSubagentInvocationOptions {
  maxTasks?: number;
}

const allowedInvocationKeys: Record<SubagentAction, readonly string[]> = {
  agents: ["action"],
  list: ["action", "status"],
  dispatch: ["action", "tasks"],
  inspect: ["action", "runIds"],
  join: ["action", "runIds"],
  remove: ["action", "conversationIds"],
};

export function parseSubagentInvocation(
  raw: unknown,
  options: ParseSubagentInvocationOptions = {},
): ParsedSubagentInvocation {
  const params = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const action = params.action;

  if (!action) {
    return {
      error: 'Provide an action: "agents", "list", "dispatch", "inspect", "join", or "remove".',
      missingAction: true,
    };
  }

  if (typeof action !== "string" || !SUBAGENT_ACTIONS.includes(action as SubagentAction)) {
    return {
      error: `Unknown action: ${String(action)}. Use "agents", "list", "dispatch", "inspect", "join", or "remove".`,
    };
  }

  const parsedAction = action as SubagentAction;
  const extra = Object.keys(params).find(
    key => !allowedInvocationKeys[parsedAction].includes(key),
  );
  if (extra) {
    const allowed = allowedInvocationKeys[parsedAction].join(", ");
    return {
      error: `Property ${extra} is not allowed for action=${parsedAction}. Allowed properties: ${allowed}.`,
      action: parsedAction,
    };
  }

  switch (parsedAction) {
    case "agents": return { action: parsedAction };
    case "list": {
      const invalidStatus = params.status !== undefined && (
        !Array.isArray(params.status)
        || params.status.length === 0
        || !params.status.every(isRunStatus)
      );
      if (invalidStatus) {
        return {
          error: "list status must be a non-empty array of valid run statuses.",
          action: parsedAction,
        };
      }

      return {
        action: parsedAction,
        ...(params.status ? { status: params.status as RunStatus[] } : {}),
      };
    }
    case "dispatch": {
      if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
        return {
          error: "Provide at least one task.",
          action: parsedAction,
          taskCountError: true,
        };
      }

      if (options.maxTasks !== undefined && params.tasks.length > options.maxTasks) {
        return {
          error: `Too many tasks (${params.tasks.length}). Max is ${options.maxTasks}.`,
          action: parsedAction,
          taskCountError: true,
        };
      }

      return { action: parsedAction, tasks: params.tasks.map(parseTask) };
    }
    case "inspect": {
      const ids = parseInspectTargets(params.runIds);
      return "error" in ids ? { ...ids, action: parsedAction } : { action: parsedAction, runIds: ids };
    }
    case "join": {
      const ids = parseIds(params.runIds, parsedAction, isRunId, isConversationId, "runId", "conversation ID");
      return "error" in ids ? { ...ids, action: parsedAction } : { action: parsedAction, runIds: ids };
    }
    case "remove": {
      const ids = parseIds(
        params.conversationIds,
        "remove",
        isConversationId,
        isRunId,
        "conversationId",
        "run ID",
      );
      return "error" in ids
        ? { ...ids, action: parsedAction }
        : { action: parsedAction, conversationIds: ids };
    }
  }
}

function parseInspectTargets(value: unknown): InspectTarget[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "inspect requires a non-empty runIds array." };
  }
  return value.map(item => {
    if (isRunId(item)) return item;
    const runId = String(item);
    return {
      runId,
      error: isConversationId(item)
        ? `inspect received invalid runId '${runId}' (a conversation ID is not accepted).`
        : `inspect received invalid runId format '${runId}'.`,
    };
  });
}

function parseIds<T extends string>(
  value: unknown,
  action: string,
  guard: (value: unknown) => value is T,
  wrongIdGuard: (value: unknown) => boolean,
  name: string,
  wrongId: string,
): T[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: `${action} requires a non-empty ${name}s array.` };
  }

  const invalidIndex = value.findIndex(item => !guard(item));
  if (invalidIndex >= 0) {
    const invalidId = value[invalidIndex];
    return {
      error: wrongIdGuard(invalidId)
        ? `${action} received invalid ${name} '${String(invalidId)}' (a ${wrongId} is not accepted).`
        : `${action} received invalid ${name} format '${String(invalidId)}'.`,
    };
  }

  return value as T[];
}

export function parseTask(raw: unknown): ParsedTask {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Task must be an object." };
  }

  const task = raw as Record<string, unknown>;
  const isSpawn = task.agent !== undefined;
  const isResume = task.conversationId !== undefined;
  const isSteer = task.runId !== undefined;
  const allowed = isSteer
    ? ["runId", "prompt"]
    : isResume
      ? ["conversationId", "prompt"]
      : ["agent", "prompt", "label", "skills", "model", "thinking", "cwd"];
  const extra = Object.keys(task).find(key => !allowed.includes(key));

  if (extra) {
    return {
      error: isSteer
        ? `Task with runId rejects ${extra}; that field belongs to a spawn task.`
        : isResume
          ? `Task with conversationId rejects ${extra}; that field belongs to a spawn task.`
          : `Task property ${extra} is not allowed for a spawn task.`,
    };
  }

  if ([isSpawn, isResume, isSteer].filter(Boolean).length !== 1) {
    return { error: "Task must carry exactly one of agent (spawn), conversationId (resume), or runId (steer)." };
  }

  if (typeof task.prompt !== "string" || !task.prompt.trim()) {
    return { error: "Task prompt must be a non-empty string." };
  }

  if (isSteer) {
    if (!isRunId(task.runId)) {
      return {
        error: isConversationId(task.runId)
          ? `Task runId '${task.runId}' is invalid (a conversation ID is not accepted).`
          : `Task received invalid runId format '${String(task.runId)}'.`,
      };
    }

    return {
      kind: "steer",
      runId: task.runId,
      prompt: task.prompt,
    };
  }

  if (isResume) {
    if (!isConversationId(task.conversationId)) {
      return {
        error: isRunId(task.conversationId)
          ? `Task conversationId '${task.conversationId}' is invalid (a run ID is not accepted).`
          : `Task received invalid conversationId format '${String(task.conversationId)}'.`,
      };
    }

    return {
      kind: "resume",
      conversationId: task.conversationId,
      prompt: task.prompt,
    };
  }

  if (typeof task.agent !== "string" || !task.agent.trim()) {
    return { error: "Task agent must be a non-empty string." };
  }

  if (task.label !== undefined && (typeof task.label !== "string" || !task.label.trim())) {
    return { error: "Task label must be a non-empty string when present." };
  }

  if (task.skills !== undefined && (
    !Array.isArray(task.skills)
    || !task.skills.every(skill => typeof skill === "string" && skill.trim())
  )) {
    return { error: "Task skills must contain only non-empty strings." };
  }

  for (const field of ["model", "cwd"] as const) {
    const value = task[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      return { error: `Task ${field} must be a non-empty string when present.` };
    }
  }

  if (task.thinking !== undefined && !isModelThinkingLevel(task.thinking)) {
    return {
      error: `Task thinking must be one of: ${MODEL_THINKING_LEVELS.join(", ")}.`,
    };
  }

  return {
    kind: "spawn",
    agent: task.agent,
    prompt: task.prompt,
    ...(task.label !== undefined ? { label: task.label as string } : {}),
    ...(task.skills !== undefined ? { skills: task.skills as string[] } : {}),
    ...(task.model !== undefined ? { model: task.model as string } : {}),
    ...(task.thinking !== undefined ? { thinking: task.thinking as ModelThinkingLevel } : {}),
    ...(task.cwd !== undefined ? { cwd: task.cwd as string } : {}),
  };
}
