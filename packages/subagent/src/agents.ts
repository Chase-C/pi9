import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project" | "package";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscovery {
  agents: AgentConfig[];
  searched: string[];
}

function getAgentDir() {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getPackageAgentsDir() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "agents");
}

function parseAgentFile(filePath: string, source: AgentSource): AgentConfig | undefined {
  const content = readFileSync(filePath, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;

  const frontmatter: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }

  if (!frontmatter.name || !frontmatter.description) return undefined;

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    model: frontmatter.model,
    tools: frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean),
    systemPrompt: match[2].trim(),
    source,
    filePath,
  };
}

function loadAgents(dir: string, source: AgentSource): AgentConfig[] {
  if (!existsSync(dir)) return [];

  const agents: AgentConfig[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith(".md") || entry.name.endsWith(".chain.md")) continue;

    try {
      const agent = parseAgentFile(join(dir, entry.name), source);
      if (agent) agents.push(agent);
    } catch {
      // Ignore malformed or unreadable agent files. The list command shows only valid agents.
    }
  }
  return agents;
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    const candidate = join(current, ".pi", "agents");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep walking
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscovery {
  const searched: string[] = [];
  const byName = new Map<string, AgentConfig>();

  const packageDir = getPackageAgentsDir();
  searched.push(packageDir);
  for (const agent of loadAgents(packageDir, "package")) byName.set(agent.name, agent);

  if (scope === "user" || scope === "both") {
    const userDir = join(getAgentDir(), "agents");
    searched.push(userDir);
    for (const agent of loadAgents(userDir, "user")) byName.set(agent.name, agent);
  }

  if (scope === "project" || scope === "both") {
    const projectDir = nearestProjectAgentsDir(cwd);
    if (projectDir) {
      searched.push(projectDir);
      for (const agent of loadAgents(projectDir, "project")) byName.set(agent.name, agent);
    }
  }

  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), searched };
}

export function summarizeAgents(agents: AgentConfig[]) {
  return agents.map((agent) => `${agent.name} (${agent.source}) — ${agent.description}`).join("\n");
}
