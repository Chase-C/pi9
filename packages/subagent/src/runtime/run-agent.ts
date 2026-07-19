import { readFileSync } from "node:fs";
import path from "node:path";

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ExtensionContext,
  getAgentDir,
  loadSkills,
  SessionManager,
  stripFrontmatter,
  SettingsManager,
  type AgentSession,
  type ModelRegistry,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import type { Attempt } from "../domain/agent-attempt.js";
import { discoverInheritedExtensionPaths } from "./extension-paths.js";
import { timingAsync } from "./timing.js";
import { completedRun, errorRun, interruptedRun, skippedRun } from "../domain/agent-finalize.js";
import type { AgentRunSnapshot } from "../domain/agent-snapshot.js";

export interface RunAgentDependencies {
  ResourceLoader: typeof DefaultResourceLoader;
  getAgentDir: typeof getAgentDir;
  createAgentSession: typeof createAgentSession;
  sessionManager: typeof SessionManager.inMemory;
  settingsManager: typeof SettingsManager.create;
  loadSkills: typeof loadSkills;
  readSkillFile: typeof readFileSync;
  loadExtensionPaths: (cwd: string, agentDir: string) => Promise<string[]>;
  childToolFor?: (agent: Agent) => ToolDefinition;
}

export const DefaultRunAgentDependencies: RunAgentDependencies = {
  ResourceLoader: DefaultResourceLoader,
  getAgentDir,
  createAgentSession,
  sessionManager: SessionManager.inMemory,
  settingsManager: SettingsManager.create,
  loadSkills,
  readSkillFile: readFileSync,
  loadExtensionPaths: discoverInheritedExtensionPaths,
};

export async function RunAttempt(
  ctx: ExtensionContext,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
  dependencies: RunAgentDependencies = DefaultRunAgentDependencies,
): Promise<AgentRunSnapshot> {
  if (attempt.kind === "resume") {
    const session = agent.sessionForResume();
    if (!session) {
      throw new Error(`Cannot resume an agent without a conversation session.`);
    }
    agent.bindSession(session);
    return PromptAgent(session, agent, attempt, signal);
  }

  if (signal?.aborted) return skippedRun(agent, attempt.runId);

  const runData = { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parent?.conversationId };
  const requestedConfig = agent.requestedConfig;
  const cwd = ResolveTaskCwd(ctx.cwd, requestedConfig.cwd);
  const agentDir = dependencies.getAgentDir();

  const requestedSkills = requestedConfig.skills ?? [];
  let systemPrompt = agent.config.systemPrompt;
  if (requestedSkills.length > 0) {
    const { skills: available } = dependencies.loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
    const matched: Skill[] = [];
    let missingSkill: string | undefined;
    for (const name of requestedSkills) {
      const found = available.find(skill => skill.name === name);
      if (!found) { missingSkill = name; break; }
      matched.push({ ...found, disableModelInvocation: false });
    }
    if (missingSkill) return errorRun(agent, attempt.runId, `Unknown skill: ${missingSkill}`);

    try {
      const skillBlocks = matched.map(skill => {
        const content = dependencies.readSkillFile(skill.filePath, "utf-8");
        const body = stripFrontmatter(content).trim();
        return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      });
      systemPrompt = `${systemPrompt}\n\n${skillBlocks.join("\n\n")}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorRun(agent, attempt.runId, `Could not load requested skill: ${message}`);
    }
  }

  const inheritedExtensionPaths = await dependencies.loadExtensionPaths(cwd, agentDir);
  const childTool = dependencies.childToolFor?.(agent);

  const resourceLoader = new dependencies.ResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    additionalExtensionPaths: inheritedExtensionPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await timingAsync("runAgent.resourceLoader.reload", { ...runData, cwd }, () => resourceLoader.reload());
  if (signal?.aborted) return skippedRun(agent, attempt.runId);

  const selectedModel = SelectModel(requestedConfig.model, ctx.model, ctx.modelRegistry);
  const requestedThinking = requestedConfig.thinking;
  const sessionManager = dependencies.sessionManager(cwd);
  const settingsManager = dependencies.settingsManager(cwd, agentDir);
  const { session } = await timingAsync("runAgent.createAgentSession", { ...runData, cwd, model: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined }, () => dependencies.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    model: selectedModel,
    thinkingLevel: requestedThinking,
    tools: requestedConfig.tools ? [...requestedConfig.tools] : undefined,
    customTools: childTool ? [childTool] : [],
    sessionManager,
    settingsManager,
  }));

  const effectiveModel = session.model ?? selectedModel;
  const effectiveThinking = session.thinkingLevel ?? requestedThinking;
  const activeTools = typeof session.getActiveToolNames === "function"
    ? session.getActiveToolNames()
    : requestedConfig.tools ?? [];
  agent.setEffectiveConfig({
    ...(effectiveModel ? { model: `${effectiveModel.provider}/${effectiveModel.id}` } : {}),
    ...(effectiveThinking ? { thinking: effectiveThinking as ModelThinkingLevel } : {}),
    cwd,
    skills: requestedSkills,
    tools: activeTools,
  });

  if (signal?.aborted) {
    await AbortSession(session);
    return skippedRun(agent, attempt.runId);
  }

  agent.bindSession(session);
  return PromptAgent(session, agent, attempt, signal);
}

async function PromptAgent(
  session: AgentSession,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
): Promise<AgentRunSnapshot> {
  const prompt = attempt.prompt;
  const onAbort = () => { void AbortSession(session); }

  if (signal?.aborted) {
    await AbortSession(session);
    return interruptedRun(agent, attempt.runId, "Agent interrupted.");
  }

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await timingAsync("runAgent.session.prompt", { agent: agent.agentName, conversationId: agent.conversationId, promptLength: prompt.length }, () => session.prompt(prompt));
    const finalMessage = GetFinalAssistantMessage(session);
    if (finalMessage.stopReason === "aborted") {
      return interruptedRun(agent, attempt.runId, finalMessage.errorMessage || "Agent interrupted.");
    }
    if (finalMessage.stopReason === "error") {
      return errorRun(agent, attempt.runId, finalMessage.errorMessage || finalMessage.response || "Agent failed.");
    }

    return completedRun(agent, attempt.runId, finalMessage.response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return signal?.aborted
      ? interruptedRun(agent, attempt.runId, message)
      : errorRun(agent, attempt.runId, message);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function AbortSession(session: AgentSession) {
  await Promise.resolve(session.abort()).catch(() => undefined);
}

function ResolveTaskCwd(ctxCwd: string, taskCwd: string | undefined) {
  if (!taskCwd) return ctxCwd;
  return path.isAbsolute(taskCwd) ? taskCwd : path.resolve(ctxCwd, taskCwd);
}

function SelectModel(
  agentModel: string | undefined,
  parentModel: Model<any> | undefined,
  registry: ModelRegistry,
): Model<any> | undefined {
  if (!agentModel) return parentModel;

  let modelId: string;
  let provider: string | undefined;

  const parts = agentModel.split("/");
  if (parts.length == 1) {
    modelId = parts[0];
  } else if (parts.length == 2) {
    provider = parts[0];
    modelId = parts[1];
  } else {
    return parentModel;
  }

  if (provider) {
    for (const model of registry.getAll()) {
      if (model.provider == provider && model.id == modelId) return model;
    }
  } else {
    const candidates = registry.getAll().filter((model) => model.id == modelId);
    // Prefer, but do not require, the same provider as the default model
    const sameProvider = candidates.find((model) => model.provider === parentModel?.provider);
    return sameProvider ?? candidates[0] ?? parentModel;
  }

  return parentModel;
}

function GetFinalAssistantMessage(
  session: AgentSession,
): { response: string; stopReason?: string; errorMessage?: string } {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role == "assistant") {
      return {
        response: msg.content
          .filter(part => part.type === "text")
          .map(part => part.text)
          .join("\n")
          .trim() ?? "",
        stopReason: msg.stopReason,
        errorMessage: msg.errorMessage,
      };
    }
  }
  return { response: "" };
}
