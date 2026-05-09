import type { ModelThinkingLevel } from "@mariozechner/pi-ai";
import { Type, type Static } from "typebox";

export const TaskSchema = Type.Object({
  agent: Type.String({ description: "Agent runtime name from ~/.pi/agent/agents or the nearest .pi/agents under the current cwd" }),
  prompt: Type.String({ description: "The task to delegate to the subagent" }),
  label: Type.Optional(Type.String({
    description: "Optional human-readable label shown in widgets and logs. When omitted, the agent's name is shown instead."
  })),
  model: Type.Optional(Type.String({ description: "Model for this subagent" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level for this subagent" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this subagent" })),
});

export const SubagentParams = Type.Object({
  action: Type.String({
    description: "Subagent operation to perform. Use 'list' to list available agents or active sessions, 'start' to run new tasks, 'resume' to continue a paused session, and 'clear' to remove a paused session.",
  }),
  tasks: Type.Optional(Type.Array(TaskSchema, { description: "One to eight subagent tasks to run for action=start" })),
  type: Type.Optional(Type.String({
    description: "Type of items to list for action='list'. Use 'agents' to list available agents or 'sessions' to list active sessions. Defaults to 'agents'",
  })),
  sessionId: Type.Optional(Type.String({ description: "Resumable subagent session id for action=resume or action=clear" })),
  prompt: Type.Optional(Type.String({ description: "Follow-up prompt for action=resume" })),
});

export type SubagentParams = Static<typeof SubagentParams>;

export interface AgentOptions {
  agent: string;
  prompt: string;
  label?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
}
