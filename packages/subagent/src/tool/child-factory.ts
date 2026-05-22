import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { Agent } from "../domain/agent.js";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import type { SubagentSettings } from "../config/settings.js";
import { defineSubagentTool } from "./define-subagent-tool.js";

export interface ChildFactoryDeps {
  manager: AgentManager;
  registry: AgentRegistry;
  parent: Agent;
  getCurrentSettings: () => SubagentSettings;
}

/**
 * Returns an ExtensionFactory that registers a `subagent` tool inside a child Pi session,
 * delegating into the shared manager so the entire tree lives in one process. The child
 * tool skips settings and registry reloads — they are already populated by the parent
 * invocation that triggered the child — and threads `parent.id` as the new agents'
 * `parentSessionId`.
 */
export function makeChildSubagentFactory(deps: ChildFactoryDeps): ExtensionFactory {
  const { manager, registry, parent, getCurrentSettings } = deps;
  return (pi) => {
    pi.registerTool(defineSubagentTool({
      agentManager: manager,
      agentRegistry: registry,
      getCurrentSettings,
      prepareInvocation: async () => getCurrentSettings(),
      parentSessionId: parent.id,
    }));
  };
}
