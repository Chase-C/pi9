import type { ModelThinkingLevel } from "@mariozechner/pi-ai";

export interface AgentOptions {
  agent: string;
  prompt: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  cwd?: string;
}
