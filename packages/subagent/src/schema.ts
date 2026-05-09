import type { ModelThinkingLevel } from "@mariozechner/pi-ai";
import { Type, type Static } from "typebox";

export const TaskSchema = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent runtime name from ~/.pi/agent/agents or the nearest .pi/agents under the current cwd. Required for a new spawn; mutually exclusive with sessionId." })),
  sessionId: Type.Optional(Type.String({ description: "Resumable session id to continue. Required for a resume; mutually exclusive with agent. When set, model/thinking/cwd/skills are rejected; only label and resumable can be re-asserted." })),
  prompt: Type.String({ description: "The task to delegate to the subagent" }),
  label: Type.Optional(Type.String({
    description: "Optional human-readable label shown in widgets and logs. When omitted, the agent's name is shown instead. On resume, a new label overwrites the stored one."
  })),
  resumable: Type.Optional(Type.Boolean({
    description: "Override the agent's default resumable setting for this task. Decision is one-way after completion: a non-resumable session is discarded immediately."
  })),
  model: Type.Optional(Type.String({ description: "Model for this subagent (spawn only)" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level for this subagent (spawn only)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this subagent (spawn only)" })),
  skills: Type.Optional(Type.Array(Type.String(), {
    description: "Skill names to inject into this subagent's system prompt. Spawn only. Unknown skill names are a hard error. Explicit skills bypass the disable-model-invocation flag."
  })),
});

export const SubagentParams = Type.Object({
  action: Type.String({
    description: "Subagent operation to perform. Use 'list' to list available agents, sessions, or skills, 'run' to spawn or resume tasks, and 'clear' to remove a paused session.",
  }),
  tasks: Type.Optional(Type.Array(TaskSchema, { description: "One to eight subagent tasks to run for action=run. Each task is either a spawn (carrying agent) or a resume (carrying sessionId)." })),
  type: Type.Optional(Type.String({
    description: "Type of items to list for action='list'. Use 'agents' to list available agents, 'sessions' for active or retained sessions, or 'skills' for skills available to inject. Defaults to 'agents'.",
  })),
  sessionId: Type.Optional(Type.String({ description: "Resumable subagent session id for action=clear" })),
});

export type SubagentParams = Static<typeof SubagentParams>;

export interface AgentOptions {
  agent: string;
  prompt: string;
  label?: string;
  resumable?: boolean;
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
  skills?: string[];
}

export type TaskRequest =
  | {
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
  | {
      kind: "resume";
      sessionId: string;
      prompt: string;
      label?: string;
      resumable?: boolean;
    };

export type ParsedTask = TaskRequest | { error: string };

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
