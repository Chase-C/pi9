import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { Agent } from "../domain/agent.js";
import type { AgentRegistry } from "../domain/agent-registry.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import type { SubagentSettings } from "../config/settings.js";
import { defineSubagentTool } from "./define-subagent-tool.js";

export interface ChildToolDeps {
  manager: AgentManager;
  registry: AgentRegistry;
  parent: Agent;
  getCurrentSettings: () => SubagentSettings;
}

export function makeChildSubagentTool(deps: ChildToolDeps): ToolDefinition {
  const { manager, registry, parent, getCurrentSettings } = deps;
  return defineSubagentTool({
    agentManager: manager,
    agentRegistry: registry,
    getCurrentSettings,
    prepareInvocation: async () => getCurrentSettings(),
    parentConversationId: parent.conversationId,
    parentRunId: () => parent.requireCurrentAttempt().runId,
  });
}
