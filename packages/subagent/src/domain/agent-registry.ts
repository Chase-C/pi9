import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

import { AgentConfig, AgentSource, BuildAgentConfig } from "./agent-config.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentAgentDiscoverySettings } from "../ui/settings.js";

export interface AgentRegistryOptions {
  discovery?: Partial<SubagentAgentDiscoverySettings>;
  defaultResumable?: boolean;
  onWarning?: (message: string) => void;
}

export class AgentRegistry {

  private _agents = new Map<string, AgentConfig>();
  get agents(): Map<string, AgentConfig> { return this._agents }

  /**
   * Load agent configs from the following directories:
   *   - Project: <cwd>/.pi/agents/*.md
   *   - Global:  <pi-dir>/agents/*.md
   */
  async reload(cwd: string = process.cwd(), options: AgentRegistryOptions = {}): Promise<void> {
    const discovery = { ...DEFAULT_SUBAGENT_SETTINGS.agentDiscovery, ...options.discovery };
    const globalDir = discovery.includeUserAgents ? join(getAgentDir(), "agents") : undefined;
    const projectDir = discovery.includeProjectAgents && discovery.projectAgentsStrategy !== "off"
      ? nearestProjectAgentsDir(cwd)
      : undefined;
    const agents = new Map<string, AgentConfig>();
    const extensions = new Set(discovery.agentFileExtensions);

    async function loadAgents(dir: string | undefined, source: AgentSource): Promise<void> {
      if (!dir || !existsSync(dir)) { return }
      const all = await readdir(dir);
      const files = all.filter(f => extensions.has(extname(f)));

      for (const file of files) {
        const path = join(dir, file);
        let content: string;

        try {
          content = await readFile(path, { encoding: "utf-8" });
        } catch (error) {
          if (discovery.warnOnInvalidAgents) options.onWarning?.(`Failed to read subagent definition ${path}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }

        const result = BuildAgentConfig(content, source, { defaultResumable: options.defaultResumable });
        if ("error" in result) {
          if (discovery.warnOnInvalidAgents) options.onWarning?.(`Invalid subagent definition ${path}: ${result.error.message}`);
          continue;
        } else {
          agents.set(result.name, { ...result, sourcePath: path });
        }
      }
    }

    const loadOrder: Array<[string | undefined, AgentSource]> = discovery.duplicateNamePolicy === "userOverridesProject"
      ? [[projectDir, "project"], [globalDir, "user"]]
      : [[globalDir, "user"], [projectDir, "project"]];
    for (const [dir, source] of loadOrder) await loadAgents(dir, source);
    this._agents = agents;
  }

  summarizeAgent(): string {
    return Array.from(this.agents.values())
      .map(agent => `${agent.name} (${agent.source}) — ${agent.description}`).join("\n");
  }
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, ".pi", "agents");
    if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
