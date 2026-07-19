import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./domain/model-thinking-level.js";
import { isConversationId, type ConversationId } from "./domain/conversation-id.js";
import { isRunId, type RunId } from "./domain/run-id.js";

export { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./domain/model-thinking-level.js";

const NonBlankString = (description: string) =>
  Type.String({ minLength: 1, pattern: ".*\\S.*", description });

export const TaskSchema = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent definition name." })),
  conversationId: Type.Optional(Type.String()),
  prompt: NonBlankString("The subagent's complete instructions."),
  label: Type.Optional(NonBlankString("Display label.")),
  skills: Type.Optional(Type.Array(Type.String(), { description: "Skills override." })),
  model: Type.Optional(Type.String({ description: "Model override." })),
  thinking: Type.Optional(StringEnum(MODEL_THINKING_LEVELS)),
  cwd: Type.Optional(Type.String({ description: "Working directory override." })),
}, { additionalProperties: false });

export const SUBAGENT_ACTIONS = ["agents", "list", "run", "join", "remove"] as const;
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

export type TaskRequest = SpawnRequest | ResumeRequest;
export type ParsedTask = TaskRequest | { error: string };

export type SubagentInvocation =
  | { action: "agents" }
  | { action: "list"; status?: RunStatus[] }
  | { action: "run"; tasks: TaskRequest[] }
  | { action: "join"; runIds: RunId[] }
  | { action: "remove"; conversationIds: ConversationId[] };

export type SubagentInvocationParseError = {
  error: string;
  action?: SubagentAction;
  errors?: string[];
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
  run: ["action", "tasks"],
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
      error: 'Provide an action: "agents", "list", "run", "join", or "remove".',
      missingAction: true,
    };
  }

  if (action === "results") {
    return { error: "The results action was removed. Use action=join with runIds." };
  }

  if (typeof action !== "string" || !SUBAGENT_ACTIONS.includes(action as SubagentAction)) {
    return {
      error: `Unknown action: ${String(action)}. Use "agents", "list", "run", "join", or "remove".`,
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

      const tasks = params.tasks.map(parseTask);
      const errors = tasks.flatMap((task, index) =>
        "error" in task ? [`task[${index}]: ${task.error}`] : [],
      );

      return errors.length > 0
        ? { error: errors.join("\n"), errors, action: parsedAction }
        : { action: parsedAction, tasks: tasks as TaskRequest[] };
    }
    case "join": {
      const ids = parseIds(params.runIds, "join", isRunId, "runId", "conversation ID");
      return "error" in ids
        ? { ...ids, action: parsedAction }
        : { action: parsedAction, runIds: ids };
    }
    case "remove": {
      const ids = parseIds(
        params.conversationIds,
        "remove",
        isConversationId,
        "conversationId",
        "run ID",
      );
      return "error" in ids
        ? { ...ids, action: parsedAction }
        : { action: parsedAction, conversationIds: ids };
    }
  }
}

function parseIds<T extends string>(
  value: unknown,
  action: string,
  guard: (value: unknown) => value is T,
  name: string,
  wrongId: string,
): T[] | { error: string } {
  const invalidArray = !Array.isArray(value)
    || value.length === 0
    || !value.every(item => typeof item === "string" && item.trim());
  if (invalidArray) {
    return { error: `${action} requires a non-empty ${name}s array.` };
  }

  const invalidId = value.find(item => !guard(item));
  if (invalidId !== undefined) {
    return {
      error: `${action} received invalid ${name} '${invalidId}' (a ${wrongId} is not accepted).`,
    };
  }

  return value as T[];
}

export function parseTask(raw: unknown): ParsedTask {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Task must be an object." };
  }

  const task = raw as Record<string, unknown>;
  if (task.sessionId !== undefined) {
    return { error: "Task field sessionId was removed. Use conversationId to resume a conversation." };
  }
  if (task.retainConversation !== undefined) {
    return { error: "Task field retainConversation was removed. Conversations are retained by default and removed with action=remove." };
  }

  const isSpawn = task.agent !== undefined;
  const isResume = task.conversationId !== undefined;
  const allowed = isResume
    ? ["conversationId", "prompt"]
    : ["agent", "prompt", "label", "skills", "model", "thinking", "cwd"];
  const extra = Object.keys(task).find(key => !allowed.includes(key));

  if (extra) {
    return {
      error: isResume
        ? `Task with conversationId rejects ${extra}; that field belongs to a spawn task.`
        : `Task property ${extra} is not allowed for a spawn task.`,
    };
  }

  if (isSpawn === isResume) {
    return { error: "Task must carry exactly one of agent (spawn) or conversationId (resume)." };
  }

  if (typeof task.prompt !== "string" || !task.prompt.trim()) {
    return { error: "Task prompt must be a non-empty string." };
  }

  if (isResume) {
    if (!isConversationId(task.conversationId)) {
      return { error: `Task conversationId '${String(task.conversationId)}' is invalid (a run ID is not accepted).` };
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
