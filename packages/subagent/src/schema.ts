import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./agents.js";
import { isConversationId, type ConversationId } from "./identifiers.js";
import { isRunId, type RunId } from "./identifiers.js";

export { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./agents.js";

const NonBlankString = () => Type.String({ minLength: 1 });

export const SpawnTaskSchema = Type.Object({
  agent: NonBlankString(),
  prompt: NonBlankString(),
  label: Type.Optional(NonBlankString()),
  skills: Type.Optional(Type.Array(NonBlankString())),
  model: Type.Optional(NonBlankString()),
  thinking: Type.Optional(StringEnum(MODEL_THINKING_LEVELS)),
  cwd: Type.Optional(NonBlankString()),
}, { additionalProperties: false });

export const ResumeTaskSchema = Type.Object({
  conversationId: NonBlankString(),
  prompt: NonBlankString(),
}, { additionalProperties: false });

export const SteerMessageSchema = Type.Object({
  runId: NonBlankString(),
  message: NonBlankString(),
}, { additionalProperties: false });

export const SUBAGENT_ACTIONS = ["agents", "list", "run", "steer", "inspect", "join", "remove"] as const;
export const RUN_STATUSES = [
  "queued", "running", "completed", "error", "aborted", "interrupted", "skipped",
] as const;

export const SubagentParams = Type.Object({
  action: StringEnum(SUBAGENT_ACTIONS),
  status: Type.Optional(Type.Array(StringEnum(RUN_STATUSES), { minItems: 1 })),
  spawnTasks: Type.Optional(Type.Array(SpawnTaskSchema, { minItems: 1 })),
  resumeTasks: Type.Optional(Type.Array(ResumeTaskSchema, { minItems: 1 })),
  steerMessages: Type.Optional(Type.Array(SteerMessageSchema, { minItems: 1 })),
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
  message: string;
};

export type RunRequest = SpawnRequest | ResumeRequest;
export type InspectTarget = RunId | { runId: string; error: string };
export type DispatchTaskKind = RunRequest["kind"] | SteerRequest["kind"];
export type ParsedRunRequest = RunRequest | { error: string };
export type ParsedSteerRequest = SteerRequest | { error: string };

export type SubagentInvocation =
  | { action: "agents" }
  | { action: "list"; status?: RunStatus[] }
  | { action: "run"; spawnTasks: ParsedRunRequest[]; resumeTasks: ParsedRunRequest[] }
  | { action: "steer"; steerMessages: ParsedSteerRequest[] }
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
  run: ["action", "spawnTasks", "resumeTasks"],
  steer: ["action", "steerMessages"],
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
      error: 'Provide an action: "agents", "list", "run", "steer", "inspect", "join", or "remove".',
      missingAction: true,
    };
  }

  if (typeof action !== "string" || !SUBAGENT_ACTIONS.includes(action as SubagentAction)) {
    return {
      error: `Unknown action: ${String(action)}. Use "agents", "list", "run", "steer", "inspect", "join", or "remove".`,
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
    case "run": {
      if (params.spawnTasks !== undefined && (!Array.isArray(params.spawnTasks) || params.spawnTasks.length === 0)) {
        return { error: "run spawnTasks must be a non-empty array when provided.", action: parsedAction, taskCountError: true };
      }
      if (params.resumeTasks !== undefined && (!Array.isArray(params.resumeTasks) || params.resumeTasks.length === 0)) {
        return { error: "run resumeTasks must be a non-empty array when provided.", action: parsedAction, taskCountError: true };
      }
      const spawnTasks = (params.spawnTasks ?? []) as unknown[];
      const resumeTasks = (params.resumeTasks ?? []) as unknown[];
      const taskCount = spawnTasks.length + resumeTasks.length;
      if (taskCount === 0) {
        return {
          error: "Provide at least one spawnTask or resumeTask.",
          action: parsedAction,
          taskCountError: true,
        };
      }

      if (options.maxTasks !== undefined && taskCount > options.maxTasks) {
        return {
          error: `Too many tasks (${taskCount}). Max is ${options.maxTasks}.`,
          action: parsedAction,
          taskCountError: true,
        };
      }

      return {
        action: parsedAction,
        spawnTasks: spawnTasks.map(parseSpawnTask),
        resumeTasks: resumeTasks.map(parseResumeTask),
      };
    }
    case "steer": {
      if (!Array.isArray(params.steerMessages) || params.steerMessages.length === 0) {
        return {
          error: "Provide at least one steerMessage.",
          action: parsedAction,
          taskCountError: true,
        };
      }

      if (options.maxTasks !== undefined && params.steerMessages.length > options.maxTasks) {
        return {
          error: `Too many steer messages (${params.steerMessages.length}). Max is ${options.maxTasks}.`,
          action: parsedAction,
          taskCountError: true,
        };
      }

      return { action: parsedAction, steerMessages: params.steerMessages.map(parseSteerMessage) };
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

export function parseSpawnTask(raw: unknown): ParsedRunRequest {
  const task = parseObject(raw);
  if (!task) return { error: "Spawn task must be an object." };
  const extra = Object.keys(task).find(key => !["agent", "prompt", "label", "skills", "model", "thinking", "cwd"].includes(key));
  if (extra) return { error: `Spawn task property ${extra} is not allowed.` };
  if (typeof task.agent !== "string" || !task.agent.trim()) return { error: "Spawn task agent must be a non-empty string." };
  const promptError = validateNonBlank(task.prompt, "Spawn task prompt");
  if (promptError) return promptError;
  if (task.label !== undefined && (typeof task.label !== "string" || !task.label.trim())) return { error: "Spawn task label must be a non-empty string when present." };
  if (task.skills !== undefined && (!Array.isArray(task.skills) || !task.skills.every(skill => typeof skill === "string" && skill.trim()))) return { error: "Spawn task skills must contain only non-empty strings." };
  for (const field of ["model", "cwd"] as const) {
    const value = task[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) return { error: `Spawn task ${field} must be a non-empty string when present.` };
  }
  if (task.thinking !== undefined && !isModelThinkingLevel(task.thinking)) return { error: `Spawn task thinking must be one of: ${MODEL_THINKING_LEVELS.join(", ")}.` };
  return {
    kind: "spawn",
    agent: task.agent,
    prompt: task.prompt as string,
    ...(task.label !== undefined ? { label: task.label as string } : {}),
    ...(task.skills !== undefined ? { skills: task.skills as string[] } : {}),
    ...(task.model !== undefined ? { model: task.model as string } : {}),
    ...(task.thinking !== undefined ? { thinking: task.thinking as ModelThinkingLevel } : {}),
    ...(task.cwd !== undefined ? { cwd: task.cwd as string } : {}),
  };
}

export function parseResumeTask(raw: unknown): ParsedRunRequest {
  const task = parseObject(raw);
  if (!task) return { error: "Resume task must be an object." };
  const extra = Object.keys(task).find(key => !["conversationId", "prompt"].includes(key));
  if (extra) return { error: `Resume task property ${extra} is not allowed.` };
  if (!isConversationId(task.conversationId)) {
    return { error: isRunId(task.conversationId)
      ? `Resume task conversationId '${task.conversationId}' is invalid (a run ID is not accepted).`
      : `Resume task received invalid conversationId format '${String(task.conversationId)}'.` };
  }
  const promptError = validateNonBlank(task.prompt, "Resume task prompt");
  return promptError ?? { kind: "resume", conversationId: task.conversationId, prompt: task.prompt as string };
}

export function parseSteerMessage(raw: unknown): ParsedSteerRequest {
  const steer = parseObject(raw);
  if (!steer) return { error: "Steer message must be an object." };
  const extra = Object.keys(steer).find(key => !["runId", "message"].includes(key));
  if (extra) return { error: `Steer message property ${extra} is not allowed.` };
  if (!isRunId(steer.runId)) {
    return { error: isConversationId(steer.runId)
      ? `Steer message runId '${steer.runId}' is invalid (a conversation ID is not accepted).`
      : `Steer message received invalid runId format '${String(steer.runId)}'.` };
  }
  const messageError = validateNonBlank(steer.message, "Steer message");
  return messageError ?? { kind: "steer", runId: steer.runId, message: steer.message as string };
}

function parseObject(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
}

function validateNonBlank(value: unknown, name: string): { error: string } | undefined {
  return typeof value === "string" && value.trim()
    ? undefined
    : { error: `${name} must be a non-empty string.` };
}
