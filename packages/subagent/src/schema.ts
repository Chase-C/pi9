import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./domain/model-thinking-level.js";

export { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./domain/model-thinking-level.js";

export const TaskSchema = Type.Object({
  agent: Type.Optional(Type.String({ description: "New session only: agent name." })),
  sessionId: Type.Optional(Type.String({ description: "Resume only: retained session handle." })),
  prompt: Type.String({ description: "Delegated task or follow-up; resumes retain prior child context." }),
  label: Type.Optional(Type.String({ description: "Display label for distinguishing tasks; required for new session." })),
  resumable: Type.Optional(Type.Boolean({ description: "true keeps child context for follow-ups; false releases it after this attempt." })),
  model: Type.Optional(Type.String({ description: "New session model override." })),
  thinking: Type.Optional(StringEnum(MODEL_THINKING_LEVELS, { description: "New session thinking override." })),
  cwd: Type.Optional(Type.String({ description: "New session working directory; relative paths use the parent cwd." })),
  skills: Type.Optional(Type.Array(Type.String(), { description: "New session skills; replaces agent defaults ([] disables)." })),
});

export const SUBAGENT_ACTIONS = ["agents", "list", "run", "results", "remove"] as const;
export const SESSION_STATUSES = ["queued", "running", "completed", "error", "aborted", "interrupted", "skipped"] as const;

export const SubagentParams = Type.Object({
  action: StringEnum(SUBAGENT_ACTIONS),
  tasks: Type.Optional(Type.Array(TaskSchema, {
    minItems: 1,
    description: "run only: tasks execute concurrently; avoid dependencies and overlapping writes.",
  })),
  background: Type.Optional(Type.Boolean({
    description: "run only: true returns handles immediately; false (default) waits for results. Background results remain available until removed.",
  })),
  status: Type.Optional(Type.Array(StringEnum(SESSION_STATUSES), { minItems: 1, description: "list only: statuses to include." })),
  sessionIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "results/remove: session handles to target." })),
  remove: Type.Optional(Type.Boolean({ description: "results only: remove terminal sessions once returned; pending sessions remain." })),
});

export type SubagentParams = Static<typeof SubagentParams>;
export type SubagentAction = typeof SUBAGENT_ACTIONS[number];
export type SessionStatus = typeof SESSION_STATUSES[number];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

export type TaskRequest =
  | SpawnRequest
  | ResumeRequest

export type SpawnRequest = {
  kind: "spawn";
  agent: string;
  prompt: string;
  label?: string;
  skills?: string[];
  resumable?: boolean;
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
}

export type ResumeRequest = {
  kind: "resume";
  sessionId: string;
  prompt: string;
  label?: string;
  resumable?: boolean;
}

export type ParsedTask = TaskRequest | { error: string };

/** The action-specific runtime representation used after the provider-facing flat schema. */
export type SubagentInvocation =
  | { action: "agents" }
  | { action: "list"; status?: SessionStatus[] }
  | { action: "run"; tasks: TaskRequest[]; background?: boolean }
  | { action: "results"; sessionIds: string[]; remove?: boolean }
  | { action: "remove"; sessionIds: string[] };

export type SubagentInvocationParseError = {
  error: string;
  action?: SubagentAction;
  errors?: string[];
  missingAction?: boolean;
  taskCountError?: boolean;
};

export type ParsedSubagentInvocation = SubagentInvocation | SubagentInvocationParseError;

export interface ParseSubagentInvocationOptions {
  /** The configured per-call fanout limit. Omit it when parsing outside a tool invocation. */
  maxTasks?: number;
}

/**
 * Converts the broad, provider-facing parameter object into one action-specific invocation.
 * The TypeBox schema intentionally remains a flat object; this is the one runtime boundary where
 * action relationships are applied.
 */
export function parseSubagentInvocation(
  raw: unknown,
  options: ParseSubagentInvocationOptions = {},
): ParsedSubagentInvocation {
  const params = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const action = params.action;

  if (!action) {
    return {
      error: 'Provide an action: "agents", "list", "run", "results", or "remove".',
      missingAction: true,
    };
  }
  if (!isSubagentAction(action)) {
    return { error: `Unknown action: ${String(action)}. Use "agents", "list", "run", "results", or "remove".` };
  }

  switch (action) {
    case "agents":
      return { action };

    case "list": {
      const status = params.status;
      if (status !== undefined && !Array.isArray(status)) {
        return { error: "list status must be an array of status strings.", action };
      }
      if (Array.isArray(status)) {
        const invalidStatus = status.find(value => !isSessionStatus(value));
        if (invalidStatus !== undefined) {
          return { error: `Unknown status '${String(invalidStatus)}'. Valid: ${SESSION_STATUSES.join(", ")}.`, action };
        }
      }
      return { action, ...(status !== undefined ? { status: status as SessionStatus[] } : {}) };
    }

    case "run": {
      const background = params.background;
      if (background !== undefined && typeof background !== "boolean") {
        return { error: "run background must be a boolean.", action };
      }

      const tasks = params.tasks;
      const taskCountError = validateTaskCount(tasks, options.maxTasks);
      if (taskCountError) return { error: taskCountError, action, taskCountError: true };

      const parsed: TaskRequest[] = [];
      const errors: string[] = [];
      (tasks as unknown[]).forEach((rawTask, index) => {
        const result = parseTask(rawTask);
        if ("error" in result) errors.push(`task[${index}]: ${result.error}`);
        else parsed.push(result);
      });
      if (errors.length > 0) return { error: errors.join("\n"), errors, action };
      return {
        action,
        tasks: parsed,
        ...(background !== undefined ? { background } : {}),
      };
    }

    case "results": {
      const remove = params.remove;
      if (remove !== undefined && typeof remove !== "boolean") {
        return { error: "results remove must be a boolean.", action };
      }

      const sessionIds = parseSessionIds(params.sessionIds, "results");
      if ("error" in sessionIds) return { ...sessionIds, action };
      return {
        action,
        sessionIds,
        ...(remove !== undefined ? { remove } : {}),
      };
    }

    case "remove": {
      if (params.sessionIds === undefined) return { error: "remove requires sessionIds.", action };
      const sessionIds = parseSessionIds(params.sessionIds, "remove");
      if ("error" in sessionIds) return { ...sessionIds, action };
      return { action, sessionIds };
    }
  }
}

function isSubagentAction(value: unknown): value is SubagentAction {
  return typeof value === "string" && (SUBAGENT_ACTIONS as readonly string[]).includes(value);
}

function validateTaskCount(tasks: unknown, maxTasks: number | undefined): string | undefined {
  if (!Array.isArray(tasks)) return "Provide a tasks array for action=run.";
  if (tasks.length === 0) return "Provide at least one task.";
  if (maxTasks !== undefined && tasks.length > maxTasks) return `Too many tasks (${tasks.length}). Max is ${maxTasks}.`;
  return undefined;
}

function parseSessionIds(value: unknown, action: "results" | "remove"): string[] | { error: string } {
  if (!isStringArray(value)) return { error: `${action} sessionIds must be an array of strings.` };
  if (!isNonEmptyStringArray(value)) return { error: `${action} sessionIds must be an array of non-empty strings.` };
  if (value.length === 0) return { error: `${action} requires at least one sessionId.` };
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string" && entry.trim() !== "");
}

export function parseTask(raw: unknown): ParsedTask {
  if (!raw || typeof raw !== "object") return { error: "Task must be an object." };
  const task = raw as Record<string, unknown>;

  const hasAgent = task.agent !== undefined;
  const hasSessionId = task.sessionId !== undefined;

  if (hasAgent && hasSessionId) {
    return { error: "Task cannot carry both agent and sessionId. Use agent for a new spawn or sessionId for a resume." };
  }
  if (!hasAgent && !hasSessionId) {
    return { error: "Task must carry exactly one of agent (spawn) or sessionId (resume)." };
  }

  if (typeof task.prompt !== "string" || task.prompt.trim() === "") {
    return { error: "Task prompt must be a non-empty string." };
  }

  if (task.label !== undefined && (typeof task.label !== "string" || task.label.trim() === "")) {
    return { error: "Task label must be a non-empty string when present." };
  }

  if (task.resumable !== undefined && typeof task.resumable !== "boolean") {
    return { error: "Task resumable must be a boolean when present." };
  }

  if (hasAgent) {
    if (typeof task.agent !== "string" || task.agent.trim() === "") {
      return { error: "Task agent must be a non-empty string." };
    }
    if (task.label === undefined) {
      return { error: "Spawn task label must be a non-empty string." };
    }
    if (task.skills !== undefined) {
      if (!Array.isArray(task.skills)) return { error: "Task skills must be an array of strings." };
      for (const name of task.skills) {
        if (typeof name !== "string" || name.trim() === "") {
          return { error: "Task skills entries must be non-empty strings." };
        }
      }
    }
    if (task.model !== undefined && (typeof task.model !== "string" || task.model.trim() === "")) {
      return { error: "Task model must be a non-empty string when present." };
    }
    if (task.thinking !== undefined && !isModelThinkingLevel(task.thinking)) {
      return { error: `Task thinking must be one of: ${MODEL_THINKING_LEVELS.join(", ")}.` };
    }
    if (task.cwd !== undefined && (typeof task.cwd !== "string" || task.cwd.trim() === "")) {
      return { error: "Task cwd must be a non-empty string when present." };
    }
    const spawn: TaskRequest = {
      kind: "spawn",
      agent: task.agent,
      prompt: task.prompt,
    };
    if (task.label !== undefined) spawn.label = task.label as string;
    if (task.skills !== undefined) spawn.skills = task.skills as string[];
    if (task.resumable !== undefined) spawn.resumable = task.resumable as boolean;
    if (task.model !== undefined) spawn.model = task.model as string;
    if (task.thinking !== undefined) spawn.thinking = task.thinking as ModelThinkingLevel;
    if (task.cwd !== undefined) spawn.cwd = task.cwd as string;
    return spawn;
  }

  // Resume task
  if (typeof task.sessionId !== "string" || task.sessionId.trim() === "") {
    return { error: "Task sessionId must be a non-empty string." };
  }
  for (const field of ["model", "thinking", "cwd", "skills"] as const) {
    if (task[field] !== undefined) {
      return { error: `Task with sessionId rejects ${field}; that field belongs to a spawn task.` };
    }
  }
  const resume: TaskRequest = {
    kind: "resume",
    sessionId: task.sessionId,
    prompt: task.prompt,
  };
  if (task.label !== undefined) resume.label = task.label as string;
  if (task.resumable !== undefined) resume.resumable = task.resumable as boolean;
  return resume;
}
