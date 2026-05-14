import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const TaskSchema = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name (spawn). Mutually exclusive with sessionId." })),
  sessionId: Type.Optional(Type.String({ description: "Retained session id (resume). Mutually exclusive with agent." })),
  prompt: Type.String({ description: "Task or follow-up to send to the subagent." }),
  label: Type.Optional(Type.String({
    description: "Human-readable label shown in widgets and logs; falls back to the agent name."
  })),
  resumable: Type.Optional(Type.Boolean({
    description: "Override the agent's resumable default. One-way at completion: false discards the session."
  })),
  model: Type.Optional(Type.String({ description: "Model override." })),
  thinking: Type.Optional(Type.String({ description: "Thinking-level override." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child." })),
  skills: Type.Optional(Type.Array(Type.String(), {
    description: "Skills injected into the system prompt. Fully replaces the agent's defaults ([] opts out); unknown names error. Explicit skills bypass disable-model-invocation."
  })),
});

export const SubagentParams = Type.Object({
  action: Type.String({
    description: "One of: agents, list, run, results, remove.",
  }),
  tasks: Type.Optional(Type.Array(TaskSchema, { description: "Tasks for action=run." })),
  background: Type.Optional(Type.Boolean({
    description: "Batch-level flag for action=run. When true, returns immediately and children continue in the background.",
  })),
  status: Type.Optional(Type.Array(Type.String(), {
    description: "Status filter for action=list.",
  })),
  sessionIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Session ids for action=remove or action=results." })),
  scope: Type.Optional(Type.String({
    description: "Removal scope for action=remove. Mutually exclusive with sessionIds.",
  })),
  remove: Type.Optional(Type.Boolean({
    description: "For action=results: sweep terminal entries after returning.",
  })),
});

export type SubagentParams = Static<typeof SubagentParams>;

export const SESSION_STATUSES = ["queued", "running", "completed", "error", "aborted", "interrupted", "skipped"] as const;
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
    if (task.thinking !== undefined && typeof task.thinking !== "string") {
      return { error: "Task thinking must be a string when present." };
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
