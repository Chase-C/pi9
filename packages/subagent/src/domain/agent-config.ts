import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { isModelThinkingLevel, MODEL_THINKING_LEVELS } from "./model-thinking-level.js";

export type AgentSource = "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  tools?: string[];
  skills?: string[];
  systemPrompt: string;
  source: AgentSource;
  sourcePath?: string;
}

const AGENT_FIELDS = new Set(["name", "description", "model", "thinking", "tools", "skills"]);

export function BuildAgentConfig(
  content: string,
  source: AgentSource,
): AgentConfig | { error: Error } {
  try {
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const unsupported = Object.keys(frontmatter).filter(field => !AGENT_FIELDS.has(field));
    if (unsupported.length > 0) {
      throw new Error(`Unsupported fields: ${unsupported.join(", ")}.`);
    }
    const result = {
      name: parseRequiredString(frontmatter.name, "name"),
      description: parseRequiredString(frontmatter.description, "description"),
      model: parseString(frontmatter.model, "model"),
      thinking: parseThinkingLevel(frontmatter.thinking),
      tools: parseCSVStrings(frontmatter.tools, "tools"),
      skills: parseCSVStrings(frontmatter.skills, "skills"),
      systemPrompt: body.trim(),
      source,
      sourcePath: undefined,
    }

    return result;
  } catch (error) {
    return { error: error as Error }
  }
}

function parseString(val: unknown, field: string): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val;
  throw new Error(`Expected field "${field}" to be a string, but got ${typeof val}.`);
}

function parseRequiredString(val: unknown, field: string): string {
  const value = parseString(val, field);
  if (value === undefined || value.trim() === "") {
    throw new Error(`Expected required field "${field}" to be a non-empty string.`);
  }
  return value;
}

function parseThinkingLevel(val: unknown): ModelThinkingLevel | undefined {
  const thinking = parseString(val, "thinking");
  if (thinking === undefined || isModelThinkingLevel(thinking)) return thinking;
  throw new Error(`Expected field "thinking" to be one of: ${MODEL_THINKING_LEVELS.join(", ")}.`);
}

function parseCSVStrings(val: unknown, field: string): Array<string> | undefined {
  if (val == null) return undefined;
  if (typeof val != "string") {
    throw new Error(`Expected field "${field}" to be a string, but got ${typeof val}.`);
  }

  const trimmed = val.trim();
  if (!trimmed || trimmed == "none") return undefined;

  const items = trimmed
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);

  return (items.length > 0)
    ? items
    : undefined
}
