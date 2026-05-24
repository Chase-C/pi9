import path from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ExtensionContext,
  formatSkillsForPrompt,
  getAgentDir,
  loadSkills,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ModelRegistry,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import type { Attempt } from "../domain/agent-attempt.js";
import { ExtensionFactoryCache } from "./extension-factory-cache.js";
import { timingAsync } from "./timing.js";
import { completedRun, errorRun, interruptedRun, skippedRun } from "../domain/agent-finalize.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";

export interface RunAgentDependencies {
  ResourceLoader: typeof DefaultResourceLoader;
  getAgentDir: typeof getAgentDir;
  createAgentSession: typeof createAgentSession;
  sessionManager: typeof SessionManager.inMemory;
  settingsManager: typeof SettingsManager.create;
  loadSkills: typeof loadSkills;
  extensionFactoryCache: Pick<ExtensionFactoryCache, "load">;
  /**
   * Builds the child-session subagent factory for the current agent. When set, the factory it
   * returns is prepended to the loader's `extensionFactories`, letting the spawned child see a
   * `subagent` tool that delegates back into the parent's shared `AgentManager`.
   */
  childFactoryFor?: (agent: Agent) => ExtensionFactory;
}

export const DefaultRunAgentDependencies: RunAgentDependencies = {
  ResourceLoader: DefaultResourceLoader,
  getAgentDir,
  createAgentSession,
  sessionManager: SessionManager.inMemory,
  settingsManager: SettingsManager.create,
  loadSkills,
  extensionFactoryCache: new ExtensionFactoryCache({
    bypass: process.env.PI_SUBAGENT_BYPASS_EXTENSION_CACHE === "1",
  }),
};

export async function RunAttempt(
  ctx: ExtensionContext,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
  dependencies: RunAgentDependencies = DefaultRunAgentDependencies,
): Promise<AgentSnapshot> {
  if (attempt.kind === "resume") {
    const session = agent.retainedSession();
    if (!session) {
      throw new Error(`Cannot resume an agent without a retained session.`);
    }
    agent.attach(session);
    return PromptAgent(session, agent, attempt, signal, true);
  }

  if (signal?.aborted) return skippedRun(agent);

  const runData = { agent: agent.agentName, sessionId: agent.id, parentSessionId: agent.parentId };
  const cwd = ResolveTaskCwd(ctx.cwd, agent.spawn.cwd);
  const agentDir = dependencies.getAgentDir();

  const requestedSkills = agent.spawn.skills ?? agent.config.skills ?? [];
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
    if (missingSkill) return errorRun(agent, `Unknown skill: ${missingSkill}`);
    const skillBlock = formatSkillsForPrompt(matched);
    if (skillBlock) systemPrompt = `${systemPrompt}\n\n${skillBlock}`;
  }

  const { factories, fallbackPaths } = await dependencies.extensionFactoryCache.load(cwd, agentDir);

  const childFactory = dependencies.childFactoryFor?.(agent);
  const allFactories: ExtensionFactory[] = childFactory ? [childFactory, ...factories] : factories;

  const resourceLoader = new dependencies.ResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    extensionFactories: allFactories,
    additionalExtensionPaths: fallbackPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await timingAsync("runAgent.resourceLoader.reload", { ...runData, cwd }, () => resourceLoader.reload());
  if (signal?.aborted) return skippedRun(agent);

  const selectedModel = SelectModel(agent.spawn.model ?? agent.config.model, ctx.model, ctx.modelRegistry);
  const sessionManager = dependencies.sessionManager(cwd);
  const settingsManager = dependencies.settingsManager(cwd, agentDir);
  const { session } = await timingAsync("runAgent.createAgentSession", { ...runData, cwd, model: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined }, () => dependencies.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    model: selectedModel,
    thinkingLevel: agent.spawn.thinking ?? agent.config.thinking,
    modelRegistry: ctx.modelRegistry,
    tools: agent.config.tools,
    sessionManager,
    settingsManager,
  }));

  if (signal?.aborted) {
    await AbortSession(session);
    return skippedRun(agent);
  }

  agent.attach(session);
  return PromptAgent(session, agent, attempt, signal);
}

async function PromptAgent(
  session: AgentSession,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
  resumed = false,
): Promise<AgentSnapshot> {
  const prompt = attempt.prompt;
  const onAbort = () => { void AbortSession(session); }

  if (signal?.aborted) {
    await AbortSession(session);
    return interruptedRun(agent, "Agent interrupted.", resumed);
  }

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await timingAsync("runAgent.session.prompt", { agent: agent.agentName, sessionId: agent.id, promptLength: prompt.length }, () => session.prompt(prompt));
    const finalMessage = GetFinalAssistantMessage(session);
    if (finalMessage.stopReason === "aborted") {
      return interruptedRun(agent, finalMessage.errorMessage || "Agent interrupted.", resumed);
    }
    if (finalMessage.stopReason === "error") {
      return errorRun(agent, finalMessage.errorMessage || finalMessage.response || "Agent failed.", resumed);
    }

    const response = agent.message || finalMessage.response;
    return completedRun(agent, response, resumed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return signal?.aborted
      ? interruptedRun(agent, message, resumed)
      : errorRun(agent, message, resumed);
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
