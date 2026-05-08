import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

import { AgentConfig, AgentSource, BuildAgentConfig } from "./agent-config.js";

export class AgentRegistry {

  private _agents = new Map<string, AgentConfig>();
  get agents(): Map<string, AgentConfig> { return this._agents }

  /**
   * Load agent configs from the following directories:
   *   - Project: <cwd>/.pi/agents/*.md
   *   - Global:  <pi-dir>/agents/*.md
   */
  async reload(cwd: string = process.cwd()): Promise<void> {
    const globalDir = join(getAgentDir(), "agents");
    const projectDir = nearestProjectAgentsDir(cwd);
    const agents = new Map<string, AgentConfig>();

    async function loadAgents(dir: string | undefined, source: AgentSource): Promise<void> {
      if (!dir || !existsSync(dir)) { return }
      const all = await readdir(dir);
      const files = all.filter(f => f.endsWith(".md"));

      for (const file of files) {
        const path = join(dir, file);
        let content: string;

        try {
          content = await readFile(path, { encoding: "utf-8" });
        } catch {
          continue;
        }

        const result = BuildAgentConfig(content, source);
        if ("error" in result) {
          continue;
        } else {
          agents.set(result.name, { ...result, sourcePath: path });
        }
      }
    }

    await loadAgents(globalDir, "user");
    await loadAgents(projectDir, "project");
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
