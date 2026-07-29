import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./agents.js";
import { isConversationId, type ConversationId } from "./identifiers.js";
import { isRunId, type RunId } from "./identifiers.js";

export { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./agents.js";

export const SpawnTaskSchema = Type.Object({
  agent: Type.String(),
  prompt: Type.String(),
  label: Type.Optional(Type.String()),
  skills: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(StringEnum(MODEL_THINKING_LEVELS)),
  cwd: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const ResumeTaskSchema = Type.Object({
  conversationId: Type.String(),
  prompt: Type.String(),
}, { additionalProperties: false });

export const SteerMessageSchema = Type.Object({
  runId: Type.String(),
  message: Type.String(),
}, { additionalProperties: false });

export const SUBAGENT_ACTIONS = ["agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", "remove"] as const;
export const RUN_STATUSES = ["queued", "running", "completed", "error", "aborted", "interrupted", "skipped"] as const;
export const CONVERSATION_STATES = ["active", "resumable", "terminal"] as const;
export const LIST_SCOPES = ["children", "descendants"] as const;

export const SubagentParams = Type.Object({
  action: StringEnum(SUBAGENT_ACTIONS),
  state: Type.Optional(Type.Array(StringEnum(CONVERSATION_STATES), { minItems: 1 })),
  scope: Type.Optional(StringEnum(LIST_SCOPES)),
  spawns: Type.Optional(Type.Array(SpawnTaskSchema, { minItems: 1 })),
  resumes: Type.Optional(Type.Array(ResumeTaskSchema, { minItems: 1 })),
  messages: Type.Optional(Type.Array(SteerMessageSchema, { minItems: 1 })),
  runIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  conversationIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
}, { additionalProperties: false });

export type SubagentParams = Static<typeof SubagentParams>;
export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type ConversationState = (typeof CONVERSATION_STATES)[number];
export type ListScope = (typeof LIST_SCOPES)[number];

export const isConversationState = (value: unknown): value is ConversationState =>
  typeof value === "string" && (CONVERSATION_STATES as readonly string[]).includes(value);

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
export type RunTarget = RunId | { runId: string; error: string };
export type ConversationTarget = ConversationId | { conversationId: string; error: string };
export type CancelTarget = RunTarget;
export type InspectTarget = RunTarget;
export type JoinTarget = RunTarget;
export type DispatchTaskKind = RunRequest["kind"] | SteerRequest["kind"];
export type ParsedRunRequest = ParsedSpawnRequest | ParsedResumeRequest;
export type ParsedSpawnRequest = SpawnRequest | { error: string; agent?: string; label?: string };
export type ParsedResumeRequest = ResumeRequest | { error: string; conversationId?: string };
export type ParsedSteerRequest = SteerRequest | { error: string; runId?: string };

export type SubagentInvocation =
  | { action: "agents" }
  | { action: "list"; scope: ListScope; state?: ConversationState[] }
  | { action: "spawn"; spawns: ParsedSpawnRequest[] }
  | { action: "resume"; resumes: ParsedResumeRequest[] }
  | { action: "steer"; messages: ParsedSteerRequest[] }
  | { action: "cancel"; runIds: CancelTarget[] }
  | { action: "inspect"; runIds: InspectTarget[] }
  | { action: "join"; runIds: JoinTarget[] }
  | { action: "remove"; conversationIds: ConversationTarget[] };

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
  list: ["action", "scope", "state"],
  spawn: ["action", "spawns"],
  resume: ["action", "resumes"],
  steer: ["action", "messages"],
  cancel: ["action", "runIds"],
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
      error: 'Provide an action: "agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", or "remove".',
      missingAction: true,
    };
  }

  if (typeof action !== "string" || !SUBAGENT_ACTIONS.includes(action as SubagentAction)) {
    return {
      error: `Unknown action: ${String(action)}. Use "agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", or "remove".`,
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
      if (params.scope !== undefined && !LIST_SCOPES.includes(params.scope as ListScope)) {
        return { error: "list scope must be children or descendants.", action: parsedAction };
      }
      const invalidState = params.state !== undefined && (
        !Array.isArray(params.state)
        || params.state.length === 0
        || !params.state.every(isConversationState)
      );
      if (invalidState) {
        return {
          error: "list state must be a non-empty array of active, resumable, or terminal.",
          action: parsedAction,
        };
      }

      return {
        action: parsedAction,
        scope: (params.scope as ListScope | undefined) ?? "children",
        ...(params.state ? { state: params.state as ConversationState[] } : {}),
      };
    }
    case "spawn": {
      const error = validateTaskArray(params.spawns, "spawn", "spawns", options.maxTasks);
      if (error) return { ...error, action: parsedAction };
      return { action: parsedAction, spawns: (params.spawns as unknown[]).map(parseSpawnTask) };
    }
    case "resume": {
      const error = validateTaskArray(params.resumes, "resume", "resumes", options.maxTasks);
      if (error) return { ...error, action: parsedAction };
      return { action: parsedAction, resumes: (params.resumes as unknown[]).map(parseResumeTask) };
    }
    case "steer": {
      if (!Array.isArray(params.messages) || params.messages.length === 0) {
        return {
          error: "Provide at least one message.",
          action: parsedAction,
          taskCountError: true,
        };
      }

      if (options.maxTasks !== undefined && params.messages.length > options.maxTasks) {
        return {
          error: `Too many steer messages (${params.messages.length}). Max is ${options.maxTasks}.`,
          action: parsedAction,
          taskCountError: true,
        };
      }

      return { action: parsedAction, messages: params.messages.map(parseSteerMessage) };
    }
    case "cancel": {
      const ids = parseRunTargets(params.runIds, parsedAction);
      return "error" in ids ? { ...ids, action: parsedAction } : { action: parsedAction, runIds: ids };
    }
    case "inspect": {
      const ids = parseRunTargets(params.runIds, parsedAction);
      return "error" in ids ? { ...ids, action: parsedAction } : { action: parsedAction, runIds: ids };
    }
    case "join": {
      const ids = parseRunTargets(params.runIds, parsedAction);
      return "error" in ids ? { ...ids, action: parsedAction } : { action: parsedAction, runIds: ids };
    }
    case "remove": {
      const ids = parseConversationTargets(params.conversationIds);
      return "error" in ids
        ? { ...ids, action: parsedAction }
        : { action: parsedAction, conversationIds: ids };
    }
  }
}

function parseRunTargets(value: unknown, action: "cancel" | "inspect" | "join"): RunTarget[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: `${action} requires a non-empty runIds array.` };
  }
  const seen = new Set<RunId>();
  return value.map(item => {
    if (isRunId(item)) {
      if (seen.has(item)) {
        return {
          runId: item,
          error: `Duplicate runId ${item} in this request; the first occurrence was processed.`,
        };
      }
      seen.add(item);
      return item;
    }
    const runId = String(item);
    return {
      runId,
      error: isConversationId(item)
        ? "Expected a run ID; received a conversation ID."
        : "Unknown or invalid run ID.",
    };
  });
}

function validateTaskArray(
  value: unknown,
  action: "spawn" | "resume",
  property: "spawns" | "resumes",
  maxTasks: number | undefined,
): { error: string; taskCountError: true } | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: `${action} requires a non-empty ${property} array.`, taskCountError: true };
  }
  if (maxTasks !== undefined && value.length > maxTasks) {
    return { error: `Too many tasks (${value.length}). Max is ${maxTasks}.`, taskCountError: true };
  }
  return undefined;
}

function parseConversationTargets(value: unknown): ConversationTarget[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "remove requires a non-empty conversationIds array." };
  }
  const seen = new Set<ConversationId>();
  return value.map(item => {
    if (isConversationId(item)) {
      if (seen.has(item)) {
        return {
          conversationId: item,
          error: `Duplicate conversationId ${item} in this request; the first occurrence was processed.`,
        };
      }
      seen.add(item);
      return item;
    }
    const conversationId = String(item);
    return {
      conversationId,
      error: isRunId(item)
        ? "Expected a conversation ID; received a run ID."
        : "Unknown or invalid conversation ID.",
    };
  });
}

export function parseSpawnTask(raw: unknown): ParsedSpawnRequest {
  const task = parseObject(raw);
  if (!task) return { error: "Spawn task must be an object." };
  const error = (message: string): ParsedSpawnRequest => ({
    error: message,
    ...(typeof task.agent === "string" && task.agent.trim() ? { agent: task.agent } : {}),
    ...(typeof task.label === "string" && task.label.trim() ? { label: task.label } : {}),
  });
  const extra = Object.keys(task).find(key => !["agent", "prompt", "label", "skills", "model", "thinking", "cwd"].includes(key));
  if (extra) return error(`Spawn task property ${extra} is not allowed.`);
  if (typeof task.agent !== "string" || !task.agent.trim()) return error("Spawn task agent must be a non-empty string.");
  const promptError = validateNonBlank(task.prompt, "Spawn task prompt");
  if (promptError) return error(promptError.error);
  if (task.label !== undefined && (typeof task.label !== "string" || !task.label.trim())) return error("Spawn task label must be a non-empty string when present.");
  if (task.skills !== undefined && (!Array.isArray(task.skills) || !task.skills.every(skill => typeof skill === "string" && skill.trim()))) return error("Spawn task skills must contain only non-empty strings.");
  for (const field of ["model", "cwd"] as const) {
    const value = task[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) return error(`Spawn task ${field} must be a non-empty string when present.`);
  }
  if (task.thinking !== undefined && !isModelThinkingLevel(task.thinking)) return error(`Spawn task thinking must be one of: ${MODEL_THINKING_LEVELS.join(", ")}.`);
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

export function parseResumeTask(raw: unknown): ParsedResumeRequest {
  const task = parseObject(raw);
  if (!task) return { error: "Resume task must be an object." };
  const identity = task.conversationId === undefined ? {} : { conversationId: String(task.conversationId) };
  const error = (message: string): ParsedResumeRequest => ({ ...identity, error: message });
  const extra = Object.keys(task).find(key => !["conversationId", "prompt"].includes(key));
  if (extra) return error(`Resume task property ${extra} is not allowed.`);
  if (!isConversationId(task.conversationId)) {
    return error(isRunId(task.conversationId)
      ? "Expected a conversation ID; received a run ID."
      : "Unknown or invalid conversation ID.");
  }
  const promptError = validateNonBlank(task.prompt, "Resume task prompt");
  return promptError ? error(promptError.error) : { kind: "resume", conversationId: task.conversationId, prompt: task.prompt as string };
}

export function parseSteerMessage(raw: unknown): ParsedSteerRequest {
  const steer = parseObject(raw);
  if (!steer) return { error: "Steer message must be an object." };
  const identity = steer.runId === undefined ? {} : { runId: String(steer.runId) };
  const error = (message: string): ParsedSteerRequest => ({ ...identity, error: message });
  const extra = Object.keys(steer).find(key => !["runId", "message"].includes(key));
  if (extra) return error(`Steer message property ${extra} is not allowed.`);
  if (!isRunId(steer.runId)) {
    return error(isConversationId(steer.runId)
      ? "Expected a run ID; received a conversation ID."
      : "Unknown or invalid run ID.");
  }
  const messageError = validateNonBlank(steer.message, "Steer message");
  return messageError ? error(messageError.error) : { kind: "steer", runId: steer.runId, message: steer.message as string };
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
