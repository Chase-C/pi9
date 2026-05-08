import { ModelThinkingLevel } from "@mariozechner/pi-ai";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentSource = "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  tools?: string[];
  resumable: boolean;
  systemPrompt: string;
  source: AgentSource;
  sourcePath?: string;
}

const requiredFields = [ "name", "description" ];

export function BuildAgentConfig(
  content: string,
  source: AgentSource,
): AgentConfig | { error: Error } {
  try {
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const result = {
      name: parseString(frontmatter.name, "name"),
      description: parseString(frontmatter.description, "description") ?? "",
      model: parseString(frontmatter.model, "model"),
      thinking: parseString(frontmatter.thinking, "thinking") as ModelThinkingLevel | undefined,
      tools: parseCSVStrings(frontmatter.tools, "tools"),
      resumable: parseBoolean(frontmatter.resumable, "resumable") ?? false,
      systemPrompt: body.trim(),
      source,
      sourcePath: undefined,
    }

    const missingFields = requiredFields.filter((field) => result[field as keyof typeof result] == null);
    if (missingFields.length > 0) {
      return { error: new Error(`Missing required fields: ${missingFields.join(", ")}`) }
    }

    return result as AgentConfig;
  } catch (error) {
    return { error: error as Error }
  }
}

function parseString(val: unknown, field: string): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val;
  throw new Error(`Expected field "${field}" to be a string, but got ${typeof val}.`);
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

function parseBoolean(val: unknown, field: string): boolean | undefined {
  if (val == null) return undefined;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    if (val === "true") return true;
    if (val === "false") return false;
  }
  throw new Error(`Expected field "${field}" to be a boolean, but got ${typeof val}.`);
}
