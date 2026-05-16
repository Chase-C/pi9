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
  type ModelRegistry,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import type { Attempt } from "../domain/agent-attempt.js";
import { ExtensionFactoryCache } from "./extension-factory-cache.js";
import { timingAsync, timingMark, timingSync } from "./timing.js";
import {
  completedRun,
  errorRun,
  interruptedRun,
  skippedRun,
  type AgentRunResult,
} from "../domain/agent-result.js";

export interface RunAgentDependencies {
  ResourceLoader: typeof DefaultResourceLoader;
  getAgentDir: typeof getAgentDir;
  createAgentSession: typeof createAgentSession;
  sessionManager: typeof SessionManager.inMemory;
  settingsManager: typeof SettingsManager.create;
  loadSkills: typeof loadSkills;
  extensionFactoryCache: Pick<ExtensionFactoryCache, "load">;
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
): Promise<AgentRunResult> {
  if (attempt.kind === "resume") {
    const session = agent.retainedSession();
    if (!session) {
      throw new Error(`Cannot resume an agent without a retained session.`);
    }
    timingSync("resumeAgent.attach", { agent: agent.agentName, sessionId: agent.id }, () => agent.attach(session));
    return PromptAgent(session, agent, attempt, signal, true);
  }

  if (signal?.aborted) return skippedRun(agent);

  const runData = { agent: agent.agentName, sessionId: agent.id };
  timingMark("runAgent.start", { ...runData, cwd: ctx.cwd, taskCwd: agent.spawn.cwd });
  const cwd = timingSync("runAgent.resolveCwd", runData, () => ResolveTaskCwd(ctx.cwd, agent.spawn.cwd));
  const agentDir = timingSync("runAgent.getAgentDir", runData, () => dependencies.getAgentDir());

  const requestedSkills = agent.spawn.skills ?? agent.config.skills ?? [];
  let systemPrompt = agent.config.systemPrompt;
  if (requestedSkills.length > 0) {
    const { skills: available } = timingSync("runAgent.loadSkills", { ...runData, cwd, requestedSkillCount: requestedSkills.length }, () => dependencies.loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }));
    const matched: Skill[] = [];
    const missingSkill = timingSync("runAgent.matchSkills", { ...runData, availableSkillCount: available.length, requestedSkillCount: requestedSkills.length }, () => {
      for (const name of requestedSkills) {
        const found = available.find(skill => skill.name === name);
        if (!found) return name;
        matched.push({ ...found, disableModelInvocation: false });
      }
      return undefined;
    });
    if (missingSkill) return errorRun(agent, `Unknown skill: ${missingSkill}`);
    const skillBlock = timingSync("runAgent.formatSkills", { ...runData, matchedSkillCount: matched.length }, () => formatSkillsForPrompt(matched));
    if (skillBlock) systemPrompt = `${systemPrompt}\n\n${skillBlock}`;
  }

  const { factories, fallbackPaths } = await timingAsync(
    "runAgent.extensionFactoryCache.load",
    { ...runData, cwd, agentDir },
    () => dependencies.extensionFactoryCache.load(cwd, agentDir),
  );
  timingMark("runAgent.extensionFactoryCache.summary", {
    ...runData,
    factoryCount: factories.length,
    fallbackCount: fallbackPaths.length,
  });

  const resourceLoader = timingSync("runAgent.newResourceLoader", { ...runData, cwd }, () => new dependencies.ResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    extensionFactories: factories,
    additionalExtensionPaths: fallbackPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  }));

  await timingAsync("runAgent.resourceLoader.reload", { ...runData, cwd }, () => resourceLoader.reload());
  if (signal?.aborted) return skippedRun(agent);

  const selectedModel = timingSync("runAgent.selectModel", { ...runData, requestedModel: agent.spawn.model ?? agent.config.model }, () => SelectModel(agent.spawn.model ?? agent.config.model, ctx.model, ctx.modelRegistry));
  const sessionManager = timingSync("runAgent.sessionManager", { ...runData, cwd }, () => dependencies.sessionManager(cwd));
  const settingsManager = timingSync("runAgent.settingsManager", { ...runData, cwd }, () => dependencies.settingsManager(cwd, agentDir));
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

  timingSync("runAgent.attach", runData, () => agent.attach(session));
  return PromptAgent(session, agent, attempt, signal);
}

async function PromptAgent(
  session: AgentSession,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
  resumed = false,
): Promise<AgentRunResult> {
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
