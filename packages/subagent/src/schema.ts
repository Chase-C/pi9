import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export const TaskSchema = Type.Object({
  agent: Type.Optional(Type.String({
    minLength: 1,
    description: "Spawn: agent name; mutually exclusive with sessionId.",
  })),
  sessionId: Type.Optional(Type.String({
    minLength: 1,
    description: "Resume: retained session ID; mutually exclusive with agent.",
  })),
  prompt: Type.String({
    minLength: 1,
    description: "Self-contained task or follow-up: goal, relevant context/files, constraints, and expected output.",
  }),
  label: Type.Optional(Type.String({
    description: "Display label for UI/logs.",
  })),
  resumable: Type.Optional(Type.Boolean({
    description: "Override conversation follow-ups. true retains context; false releases it after this attempt (foreground sessions then leave inventory).",
  })),
  model: Type.Optional(Type.String({ minLength: 1, description: "Spawn-only model override." })),
  thinking: Type.Optional(StringEnum(MODEL_THINKING_LEVELS, { description: "Spawn-only thinking override." })),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "Spawn-only working directory." })),
  skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Spawn-only skills; replaces defaults ([] disables).",
  })),
});

export const SUBAGENT_ACTIONS = ["agents", "list", "run", "results", "remove"] as const;
export const SESSION_STATUSES = ["queued", "running", "completed", "error", "aborted", "interrupted", "skipped"] as const;
export const REMOVAL_SCOPES = ["background", "retained", "non-running"] as const;

export const SubagentParams = Type.Object({
  action: StringEnum(SUBAGENT_ACTIONS, {
    description: "agents=definitions; list=sessions; run=spawn/resume; results=fetch; remove=delete or abort.",
  }),
  tasks: Type.Optional(Type.Array(TaskSchema, {
    minItems: 1,
    description: "For run. One or more spawn/resume tasks. Tasks execute concurrently; do not assign overlapping file writes.",
  })),
  background: Type.Optional(Type.Boolean({
    description: "For run. false (default) waits for all tasks and returns results; true returns handles immediately. Background results remain retrievable until removed, regardless of resumable.",
  })),
  status: Type.Optional(Type.Array(StringEnum(SESSION_STATUSES), {
    description: "For list. Session statuses to include.",
  })),
  sessionIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "For results/remove. Session handles returned by background dispatch, results, or resumable runs.",
  })),
  scope: Type.Optional(StringEnum(REMOVAL_SCOPES, {
    description: "For remove. background=all background sessions; retained=non-running resumable foreground sessions; non-running=all queued or terminal sessions. Mutually exclusive with sessionIds.",
  })),
  remove: Type.Optional(Type.Boolean({
    description: "For results. Remove terminal sessions after returning them.",
  })),
});

export type SubagentParams = Static<typeof SubagentParams>;
export type SessionStatus = typeof SESSION_STATUSES[number];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (MODEL_THINKING_LEVELS as readonly string[]).includes(value);
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

export function parseTask(raw: unknown): ParsedTask {
  if (!raw || typeof raw !== "object") return { error: "Task must be an object." };
  const task = raw as Record<string, unknown>;

  if (task.background !== undefined) {
    return { error: "background is a batch-level flag on action='run', not a per-task field." };
  }

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

  if (task.label !== undefined && typeof task.label !== "string") {
    return { error: "Task label must be a string when present." };
  }

  if (task.resumable !== undefined && typeof task.resumable !== "boolean") {
    return { error: "Task resumable must be a boolean when present." };
  }

  if (hasAgent) {
    if (typeof task.agent !== "string" || task.agent.trim() === "") {
      return { error: "Task agent must be a non-empty string." };
    }
    if (task.skills !== undefined) {
      if (!Array.isArray(task.skills)) return { error: "Task skills must be an array of strings." };
      for (const name of task.skills) {
        if (typeof name !== "string" || name.trim() === "") {
          return { error: "Task skills entries must be non-empty strings." };
        }
      }
    }
    if (task.model !== undefined && typeof task.model !== "string") {
      return { error: "Task model must be a string when present." };
    }
    if (task.thinking !== undefined && !isModelThinkingLevel(task.thinking)) {
      return { error: `Task thinking must be one of: ${MODEL_THINKING_LEVELS.join(", ")}.` };
    }
    if (task.cwd !== undefined && typeof task.cwd !== "string") {
      return { error: "Task cwd must be a string when present." };
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
