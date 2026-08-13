import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./agents.js";
import { isSubagentId, type SubagentId } from "./identifiers.js";

export { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./agents.js";

export const SUBAGENT_ACTIONS = ["agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", "remove"] as const;
export const SUBAGENT_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;

export const SpawnTaskSchema = Type.Object({
  agent: Type.String({ description: "Agent definition name." }),
  prompt: Type.String(),
  label: Type.String({ description: "3-5 words describing what, not how." }),
  skills: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(StringEnum(MODEL_THINKING_LEVELS)),
  cwd: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const ResumeTaskSchema = Type.Object({
  subagentId: Type.String(),
  prompt: Type.String({ description: "Follow-up instructions; prior context carries over." }),
}, { additionalProperties: false });

export const SteerMessageSchema = Type.Object({
  subagentId: Type.String(),
  message: Type.String(),
}, { additionalProperties: false });

export const SubagentParams = Type.Object({
  action: StringEnum(SUBAGENT_ACTIONS),
  statuses: Type.Optional(Type.Array(StringEnum(SUBAGENT_STATUSES), { minItems: 1 })),
  collected: Type.Optional(Type.Boolean()),
  spawns: Type.Optional(Type.Array(SpawnTaskSchema, { minItems: 1 })),
  resumes: Type.Optional(Type.Array(ResumeTaskSchema, { minItems: 1 })),
  messages: Type.Optional(Type.Array(SteerMessageSchema, { minItems: 1 })),
  subagentIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
}, { additionalProperties: false });

const SPAWN_TASK_KEYS = new Set(Object.keys(SpawnTaskSchema.properties));
const RESUME_TASK_KEYS = new Set(Object.keys(ResumeTaskSchema.properties));
const STEER_MESSAGE_KEYS = new Set(Object.keys(SteerMessageSchema.properties));

export type SubagentParams = Static<typeof SubagentParams>;
export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

export const isSubagentStatus = (value: unknown): value is SubagentStatus =>
  typeof value === "string" && (SUBAGENT_STATUSES as readonly string[]).includes(value);

type SpawnInput = Static<typeof SpawnTaskSchema>;
type ResumeInput = Static<typeof ResumeTaskSchema>;
type SteerInput = Static<typeof SteerMessageSchema>;

export type SpawnRequest = SpawnInput & { kind: "spawn" };
export type ResumeRequest = Omit<ResumeInput, "subagentId"> & { kind: "resume"; subagentId: SubagentId };
export type SteerRequest = Omit<SteerInput, "subagentId"> & { kind: "steer"; subagentId: SubagentId };

export type TaskRequest = SpawnRequest | ResumeRequest;
export type SubagentTarget = SubagentId | { subagentId: string; error: string };
export type DispatchTaskKind = TaskRequest["kind"] | SteerRequest["kind"];
export type ParsedSpawnRequest = SpawnRequest | { error: string; agent?: string; label?: string };
export type ParsedResumeRequest = ResumeRequest | { error: string; subagentId?: string };
export type ParsedSteerRequest = SteerRequest | { error: string; subagentId?: string };

export type SubagentInvocation =
  | { action: "agents" }
  | { action: "list"; statuses?: SubagentStatus[]; collected?: boolean }
  | { action: "spawn"; spawns: ParsedSpawnRequest[] }
  | { action: "resume"; resumes: ParsedResumeRequest[] }
  | { action: "steer"; messages: ParsedSteerRequest[] }
  | { action: "cancel"; subagentIds: SubagentTarget[] }
  | { action: "inspect"; subagentIds: SubagentTarget[] }
  | { action: "join"; subagentIds: SubagentTarget[] }
  | { action: "remove"; subagentIds: SubagentTarget[] };

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

const ACTION_LIST = `${SUBAGENT_ACTIONS.slice(0, -1).map(action => `"${action}"`).join(", ")}, or "${SUBAGENT_ACTIONS.at(-1)}"`;

const allowedInvocationKeys: Record<SubagentAction, readonly string[]> = {
  agents: ["action"],
  list: ["action", "statuses", "collected"],
  spawn: ["action", "spawns"],
  resume: ["action", "resumes"],
  steer: ["action", "messages"],
  cancel: ["action", "subagentIds"],
  inspect: ["action", "subagentIds"],
  join: ["action", "subagentIds"],
  remove: ["action", "subagentIds"],
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
      error: `Provide an action: ${ACTION_LIST}.`,
      missingAction: true,
    };
  }

  if (typeof action !== "string" || !SUBAGENT_ACTIONS.includes(action as SubagentAction)) {
    return {
      error: `Unknown action: ${String(action)}. Use ${ACTION_LIST}.`,
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
      const invalidStatuses = params.statuses !== undefined && (
        !Array.isArray(params.statuses)
        || params.statuses.length === 0
        || !params.statuses.every(isSubagentStatus)
      );
      if (invalidStatuses) {
        return {
          error: "list statuses must be a non-empty array of queued, running, completed, failed, or cancelled.",
          action: parsedAction,
        };
      }
      if (params.collected !== undefined && typeof params.collected !== "boolean") {
        return { error: "list collected must be a boolean.", action: parsedAction };
      }

      return {
        action: parsedAction,
        ...(params.statuses ? { statuses: params.statuses as SubagentStatus[] } : {}),
        ...(params.collected !== undefined ? { collected: params.collected } : {}),
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
      const resumes = (params.resumes as unknown[]).map(parseResumeTask);
      return { action: parsedAction, resumes: rejectDuplicateRequests(resumes) };
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

      const messages = params.messages.map(parseSteerMessage);
      return { action: parsedAction, messages: rejectDuplicateRequests(messages) };
    }
    case "cancel":
    case "inspect":
    case "join":
    case "remove": {
      const ids = parseSubagentTargets(params.subagentIds, parsedAction);
      return "error" in ids
        ? { ...ids, action: parsedAction }
        : { action: parsedAction, subagentIds: ids } as SubagentInvocation;
    }
  }
}

function subagentIdError(value: unknown): string {
  if (typeof value === "string" && /^[a-z]+-[a-z]+$/.test(value)) {
    return `Subagent ${value} was not found.`;
  }
  return `Invalid subagentId format: ${String(value)}.`;
}

function duplicateSubagentId(value: SubagentId): string {
  return `Duplicate subagentId ${value} in this request; only the first occurrence was attempted.`;
}

function rejectDuplicateRequests(requests: ParsedResumeRequest[]): ParsedResumeRequest[];
function rejectDuplicateRequests(requests: ParsedSteerRequest[]): ParsedSteerRequest[];
function rejectDuplicateRequests(
  requests: Array<ParsedResumeRequest | ParsedSteerRequest>,
): Array<ParsedResumeRequest | ParsedSteerRequest> {
  const seen = new Set<SubagentId>();
  return requests.map(request => {
    if ("error" in request) return request;
    if (seen.has(request.subagentId)) {
      return { subagentId: request.subagentId, error: duplicateSubagentId(request.subagentId) };
    }
    seen.add(request.subagentId);
    return request;
  });
}

function parseSubagentTargets(
  value: unknown,
  action: "cancel" | "inspect" | "join" | "remove",
): SubagentTarget[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: `${action} requires a non-empty subagentIds array.` };
  }
  const seen = new Set<SubagentId>();
  return value.map(item => {
    if (isSubagentId(item)) {
      if (seen.has(item)) return { subagentId: item, error: duplicateSubagentId(item) };
      seen.add(item);
      return item;
    }
    return { subagentId: String(item), error: subagentIdError(item) };
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

export function parseSpawnTask(raw: unknown): ParsedSpawnRequest {
  const task = parseObject(raw);
  if (!task) return { error: "Spawn task must be an object." };
  const error = (message: string): ParsedSpawnRequest => ({
    error: message,
    ...(typeof task.agent === "string" && task.agent.trim() ? { agent: task.agent } : {}),
    ...(typeof task.label === "string" && task.label.trim() ? { label: task.label } : {}),
  });
  const extra = Object.keys(task).find(key => !SPAWN_TASK_KEYS.has(key));
  if (extra) return error(`Spawn task property ${extra} is not allowed.`);
  if (typeof task.agent !== "string" || !task.agent.trim()) return error("Spawn task agent must be a non-empty string.");
  const promptError = validateNonBlank(task.prompt, "Spawn task prompt");
  if (promptError) return error(promptError.error);
  if (typeof task.label !== "string" || !task.label.trim()) return error("Spawn task label must be a non-empty string.");
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
    label: task.label as string,
    ...(task.skills !== undefined ? { skills: task.skills as string[] } : {}),
    ...(task.model !== undefined ? { model: task.model as string } : {}),
    ...(task.thinking !== undefined ? { thinking: task.thinking as SpawnInput["thinking"] } : {}),
    ...(task.cwd !== undefined ? { cwd: task.cwd as string } : {}),
  };
}

export function parseResumeTask(raw: unknown): ParsedResumeRequest {
  const task = parseObject(raw);
  if (!task) return { error: "Resume task must be an object." };
  const identity = task.subagentId === undefined ? {} : { subagentId: String(task.subagentId) };
  const error = (message: string): ParsedResumeRequest => ({ ...identity, error: message });
  const extra = Object.keys(task).find(key => !RESUME_TASK_KEYS.has(key));
  if (extra) return error(`Resume task property ${extra} is not allowed.`);
  if (!isSubagentId(task.subagentId)) return error(subagentIdError(task.subagentId));
  const promptError = validateNonBlank(task.prompt, "Resume task prompt");
  return promptError ? error(promptError.error) : { kind: "resume", subagentId: task.subagentId, prompt: task.prompt as string };
}

export function parseSteerMessage(raw: unknown): ParsedSteerRequest {
  const steer = parseObject(raw);
  if (!steer) return { error: "Steer message must be an object." };
  const identity = steer.subagentId === undefined ? {} : { subagentId: String(steer.subagentId) };
  const error = (message: string): ParsedSteerRequest => ({ ...identity, error: message });
  const extra = Object.keys(steer).find(key => !STEER_MESSAGE_KEYS.has(key));
  if (extra) return error(`Steer message property ${extra} is not allowed.`);
  if (!isSubagentId(steer.subagentId)) return error(subagentIdError(steer.subagentId));
  const messageError = validateNonBlank(steer.message, "Steer message");
  return messageError ? error(messageError.error) : { kind: "steer", subagentId: steer.subagentId, message: steer.message as string };
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
