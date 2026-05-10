import type { ModelThinkingLevel } from "@mariozechner/pi-ai";

export interface AgentSpawn {
  agent: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
  skills?: string[];
}

export interface AgentInvocation {
  prompt: string;
  label?: string;
  resumable?: boolean;
}
